import { eq, and } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { i18nMessage, type I18n } from '@/lib/i18n';
import { textError } from '@/lib/http';

// Typecho user groups: administrator(0), editor(1), contributor(2), subscriber(3), visitor(4)
export const UserGroup = {
  administrator: 'administrator',
  editor: 'editor',
  contributor: 'contributor',
  subscriber: 'subscriber',
  visitor: 'visitor',
} as const;

export type UserGroupType = typeof UserGroup[keyof typeof UserGroup];

const groupHierarchy: Record<string, number> = {
  administrator: 0,
  editor: 1,
  contributor: 2,
  subscriber: 3,
  visitor: 4,
};

/**
 * Check if a user passes a certain group level
 * Lower number = higher privilege
 */
export function hasPermission(userGroup: string, requiredGroup: string, strict = false): boolean {
  const userLevel = groupHierarchy[userGroup] ?? 4;
  const requiredLevel = groupHierarchy[requiredGroup] ?? 4;
  return strict ? userLevel === requiredLevel : userLevel <= requiredLevel;
}

/**
 * Ownership check with automatic admin override.
 *
 * `canManageResource(user, resource)` returns true when either:
 *   - the user is in the administrator group, or
 *   - the resource's owner id equals the user's uid.
 *
 * Prefer this over open-coding the pattern at API boundaries — it
 * centralises the admin-override rule so tightening (e.g. a
 * super-admin-only override) can happen in one place.
 */
export function canManageResource(
  user: { uid: number; group?: string | null },
  resource: { authorId?: number | null; ownerId?: number | null },
): boolean {
  if (hasPermission(user.group || 'visitor', 'administrator')) return true;
  const owner = resource.authorId ?? resource.ownerId ?? -1;
  return owner === user.uid;
}

/**
 * PBKDF2 iteration count for new hashes.
 *
 * Capped at 100,000 because Cloudflare Workers' Web Crypto rejects higher
 * PBKDF2 iteration counts in production (workerd#1346). OWASP recommends
 * 600,000 for PBKDF2-SHA256; we cannot reach that on this runtime.
 *
 * `verifyPassword` still honours the count embedded in a stored hash when it
 * is ≤ this value. Counts above the cap return `needs_reset` (they cannot be
 * verified on Workers). `passwordHashNeedsRehash` flags weaker hashes for
 * transparent upgrade after the next successful login.
 */
export const PBKDF2_ITERATIONS = 100_000;

/**
 * Hash a password using PBKDF2 with a random salt (Cloudflare Workers compatible).
 * Output format: $PBKDF2$iterations$salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  const iterations = PBKDF2_ITERATIONS;
  const salt = generateSalt(16);
  const hash = await pbkdf2Hash(password, salt, iterations);
  return `$PBKDF2$${iterations}$${salt}$${hash}`;
}

/**
 * Detect whether a stored PBKDF2 hash uses fewer iterations than the current
 * default. The login route uses this to opportunistically upgrade weaker
 * hashes without forcing a password reset.
 */
export function passwordHashNeedsRehash(storedHash: string): boolean {
  if (!storedHash.startsWith('$PBKDF2$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 5) return false;
  const iter = parseInt(parts[2], 10);
  if (!Number.isFinite(iter)) return false;
  return iter < PBKDF2_ITERATIONS;
}

/**
 * Verify a password against a stored hash.
 *
 * @returns `true` if the password matches, `'wrong_password'` if it doesn't,
 *          or `'needs_reset'` if the stored hash cannot be verified on this
 *          runtime (legacy formats, or PBKDF2 iterations above the Workers cap).
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<true | 'wrong_password' | 'needs_reset'> {
  if (storedHash.startsWith('$PBKDF2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 5) return 'wrong_password';
    const iterations = parseInt(parts[2], 10);
    const salt = parts[3];
    const hash = parts[4];
    if (isNaN(iterations) || !salt || !hash) return 'wrong_password';
    // Production Workers throw on PBKDF2 iterations above the platform cap;
    // force a reset instead of surfacing a 500 on login.
    if (iterations > PBKDF2_ITERATIONS) return 'needs_reset';
    const computed = await pbkdf2Hash(password, salt, iterations);
    return timeSafeEqual(hash, computed) ? true : 'wrong_password';
  }
  // Legacy hash formats — password verification not possible, force reset
  if (storedHash.startsWith('$SHA256$') ||
      storedHash.startsWith('$PHPASS$') ||
      storedHash.startsWith('$MD5$') ||
      storedHash.startsWith('$LEGACY$')) {
    return 'needs_reset';
  }
  return 'wrong_password';
}

/**
 * Generate auth token for cookie
 */
export async function generateAuthToken(uid: number, authCode: string, secret: string): Promise<string> {
  const payload = `${uid}:${authCode}`;
  const hash = await sha256(secret + payload);
  return `${uid}:${hash}`;
}

/**
 * Validate auth token from cookie
 */
export async function validateAuthToken(
  token: string,
  secret: string,
  db: Database
): Promise<{ uid: number; user: typeof schema.users.$inferSelect } | null> {
  const parts = token.split(':');
  if (parts.length !== 2) return null;

  const uid = parseInt(parts[0], 10);
  const hash = parts[1];

  if (isNaN(uid)) return null;

  const user = await db.query.users.findFirst({
    where: eq(schema.users.uid, uid),
  });

  if (!user || !user.authCode) return null;

  // Reject reset tokens during normal auth — they can't be valid sessions
  if (user.authCode.startsWith('reset:')) return null;

  const expected = await sha256(secret + `${uid}:${user.authCode}`);
  if (!timeSafeEqual(hash, expected)) return null;

  return { uid, user };
}

/**
 * Generate a CSRF security token (matches Typecho's Security widget),
 * salted with the current 1-hour bucket so tokens auto-rotate. Validation
 * accepts the current bucket plus the previous bucket to absorb cached HTML
 * straddling the boundary, capping useful lifetime at ~2 hours.
 */
const CSRF_BUCKET_SECONDS = 3600;

function currentCsrfBucket(now = Date.now()): number {
  return Math.floor(now / 1000 / CSRF_BUCKET_SECONDS);
}

export async function generateSecurityToken(secret: string, authCode: string, uid: number, bucket?: number): Promise<string> {
  const b = bucket ?? currentCsrfBucket();
  return await sha256(`${secret}${authCode}${uid}|${b}`);
}

/**
 * Validate CSRF token (accepts current or previous bucket).
 */
export async function validateSecurityToken(
  token: string,
  secret: string,
  authCode: string,
  uid: number,
  now = Date.now(),
): Promise<boolean> {
  const bucket = currentCsrfBucket(now);
  const expectedCurrent = await generateSecurityToken(secret, authCode, uid, bucket);
  if (timeSafeEqual(token, expectedCurrent)) return true;
  const expectedPrev = await generateSecurityToken(secret, authCode, uid, bucket - 1);
  return timeSafeEqual(token, expectedPrev);
}

/**
 * Validate an admin CSRF token from a request and return an error Response
 * if invalid, or null if valid. Handles token extraction from FormData (_ field),
 * query string (_ param), or JSON body (_ field).
 *
 * Use this after auth validation in admin API endpoints that perform state changes.
 */
export async function requireAdminCSRF(
  request: Request,
  secret: string,
  authCode: string,
  uid: number,
  i18n?: I18n,
): Promise<Response | null> {
  const failureMessage = i18nMessage('core.error.csrf', 'CSRF validation failed');
  const token = await extractAdminCSRFToken(request);
  if (!token) {
    return textError(403, failureMessage, undefined, i18n);
  }
  const valid = await validateSecurityToken(token, secret, authCode, uid);
  if (!valid) {
    return textError(403, failureMessage, undefined, i18n);
  }
  return null;
}

/**
 * Extract admin CSRF token from request.
 * Priority:
 *   1. X-CSRF-Token header (G8-3) — works for any method/content-type
 *      and avoids re-parsing the body. Preferred for fetch()/JSON clients.
 *   2. POST form data `_` field (legacy server-rendered form posts).
 *   3. POST JSON body `_` field.
 *   4. Query string `_` param (state-changing GETs are rare; covered for
 *      legacy callers).
 */
async function extractAdminCSRFToken(request: Request): Promise<string | null> {
  // 1. Header takes priority — covers fetch/AJAX clients without a body.
  const headerToken = request.headers.get('x-csrf-token');
  if (headerToken) return headerToken;

  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // POST with FormData → read from body
  if (method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data')) {
      try {
        const cloned = request.clone();
        const formData = await cloned.formData();
        const token = formData.get('_')?.toString();
        if (token) return token;
      } catch { /* ignore parse errors */ }
    }
    if (contentType.includes('application/json')) {
      try {
        const cloned = request.clone();
        const body = await cloned.json() as Record<string, unknown>;
        if (body._) return String(body._);
      } catch { /* ignore parse errors */ }
    }
  }

  // Fallback: query string
  const queryToken = url.searchParams.get('_');
  if (queryToken) return queryToken;

  return null;
}

/**
 * Generate a comment-form CSRF token bound to the target content ID.
 * Token = sha256(secret + '&cid=' + cid). Same-page cached HTML is fine
 * because the token depends only on the cid the form targets.
 */
export async function generateCommentToken(secret: string, cid: number): Promise<string> {
  return await sha256(`${secret}&cid=${cid}`);
}

/**
 * Validate a comment form CSRF token. Rejects if it doesn't match the
 * cid-bound expected value — no referer fallback, so an attacker cannot
 * reuse a token issued for /archives/1/ to post on /archives/2/.
 */
export async function validateCommentToken(
  token: string,
  secret: string,
  cid: number,
): Promise<boolean> {
  const expected = await generateCommentToken(secret, cid);
  return timeSafeEqual(token, expected);
}

// ---- Utilities ----

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns false if strings differ in length (without leaking which bytes differ).
 */
export function timeSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  // Constant-time comparison: XOR all bytes and accumulate differences
  // This avoids short-circuit evaluation that leaks timing information
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a hex-encoded hash using PBKDF2 with SHA-256.
 */
async function pbkdf2Hash(password: string, salt: string, iterations: number): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hashArray = Array.from(new Uint8Array(derivedBits));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a cryptographically random salt of the given length (in bytes),
 * returned as a hex-encoded string.
 */
function generateSalt(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a cryptographically random alphanumeric string of the given length.
 * Uses rejection sampling to avoid modulo bias.
 */
export function generateRandomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const charsLen = chars.length; // 62
  // Largest multiple of charsLen that fits in a byte (252 = 62 * 4)
  const limit = 256 - (256 % charsLen);
  const result: string[] = [];
  while (result.length < length) {
    const batch = new Uint8Array(length - result.length);
    crypto.getRandomValues(batch);
    for (const b of batch) {
      if (result.length >= length) break;
      if (b < limit) {
        result.push(chars[b % charsLen]);
      }
    }
  }
  return result.join('');
}

// ---- Cookie helpers ----

const AUTH_COOKIE_NAME = '__typecho_uid';
const AUTH_CODE_COOKIE_NAME = '__typecho_authCode';

/**
 * Whether the request should be treated as HTTPS for Secure cookies / HSTS.
 * Prefer the request URL scheme (Cloudflare Workers serve https:// at the edge).
 * Also honour a trusted `x-forwarded-proto: https` for TLS-terminated proxies.
 *
 * Trust model: only enable forwarded-proto reliance behind a proxy that strips
 * or overwrites client-supplied X-Forwarded-Proto. On the Cloudflare Worker
 * edge the request URL is already https://, so the header is unused.
 */
export function isRequestHttps(request?: Request): boolean {
  if (!request) return true;
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch {
    return true;
  }
  const forwarded = request.headers.get('x-forwarded-proto');
  if (!forwarded) return false;
  return forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * Decide whether to emit the `Secure` cookie attribute. Production deploys
 * always run on HTTPS via Cloudflare, but `pnpm run dev` exposes the worker
 * over plain http://localhost. Marking cookies Secure on http drops them.
 */
export function shouldUseSecureCookie(request?: Request): boolean {
  return isRequestHttps(request);
}

export function getAuthCookies(cookieHeader: string | null): { token: string | null; uid: string | null; code: string | null } {
  if (!cookieHeader) return { token: null, uid: null, code: null };
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...vals] = c.trim().split('=');
      return [key, vals.join('=')];
    })
  );
  const uid = cookies[AUTH_COOKIE_NAME] || null;
  const code = cookies[AUTH_CODE_COOKIE_NAME] || null;
  if (uid && code) {
    return { token: `${uid}:${code}`, uid, code };
  }
  return { token: null, uid: null, code: null };
}

/**
 * Lightweight check used by the edge cache layer: returns true only when
 * both auth cookies are present and look syntactically valid (uid is a
 * number, code is non-empty). substring matching against the cookie header
 * is unsafe because attackers can name unrelated cookies similarly and
 * stale cookies linger after logout.
 */
export function hasAuthCookies(cookieHeader: string | null): boolean {
  const { uid, code } = getAuthCookies(cookieHeader);
  if (!uid || !code) return false;
  return /^\d+$/.test(uid) && code.length > 0;
}

export function setAuthCookieHeaders(uid: number, hash: string, maxAge = 30 * 24 * 3600, request?: Request): string[] {
  const secureFlag = shouldUseSecureCookie(request) ? '; Secure' : '';
  const base = `Path=/; HttpOnly${secureFlag}; SameSite=Lax`;
  const opts = maxAge > 0 ? `${base}; Max-Age=${maxAge}` : base;
  return [
    `${AUTH_COOKIE_NAME}=${uid}; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=${hash}; ${opts}`,
  ];
}

export function clearAuthCookieHeaders(request?: Request): string[] {
  const secureFlag = shouldUseSecureCookie(request) ? '; Secure' : '';
  const opts = `Path=/; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=0`;
  return [
    `${AUTH_COOKIE_NAME}=; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=; ${opts}`,
  ];
}

// ── Password reset tokens ─────────────────────────────────────────────

const RESET_TOKEN_PREFIX = 'reset:';
export const RESET_TOKEN_EXPIRY_SEC = 3600;

export function generateResetToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${RESET_TOKEN_PREFIX}${hex}`;
}

export async function hashResetToken(token: string): Promise<string> {
  return sha256(token);
}

export interface ResetToken {
  valid: boolean;
  uid?: number;
  error?: 'expired' | 'malformed' | 'consumed';
}

export async function parseResetToken(
  token: string,
  db: Database,
  now = Math.floor(Date.now() / 1000),
): Promise<ResetToken> {
  if (!token.startsWith(RESET_TOKEN_PREFIX)) return { valid: false, error: 'malformed' };
  const body = token.slice(RESET_TOKEN_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(body)) return { valid: false, error: 'malformed' };

  const tokenHash = await hashResetToken(token);
  const pending = await db.query.passwordResetRequests.findFirst({
    where: eq(schema.passwordResetRequests.tokenHash, tokenHash),
    columns: { uid: true, expiresAt: true },
  });
  if (!pending?.uid || !pending.expiresAt) return { valid: false, error: 'consumed' };
  if (pending.expiresAt < now) return { valid: false, error: 'expired' };

  return { valid: true, uid: pending.uid };
}
