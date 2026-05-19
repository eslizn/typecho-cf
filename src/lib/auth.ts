import { eq, and } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';

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
 * Recommended PBKDF2 iteration count (OWASP 2024+).
 * `verifyPassword` honours whatever count is embedded in the stored hash, so
 * raising this value is fully backwards compatible — older hashes still
 * verify, and `passwordHashNeedsRehash` flags them for transparent upgrade
 * after the next successful login.
 */
export const PBKDF2_ITERATIONS = 600_000;

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
 * recommendation. The login route uses this to opportunistically upgrade
 * legacy hashes to the new strength without forcing a password reset.
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
 *          or `'needs_reset'` if the stored hash is a legacy format that
 *          requires the user to reset their password.
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
): Promise<Response | null> {
  const token = await extractAdminCSRFToken(request);
  if (!token) {
    return new Response('CSRF validation failed', { status: 403 });
  }
  const valid = await validateSecurityToken(token, secret, authCode, uid);
  if (!valid) {
    return new Response('CSRF validation failed', { status: 403 });
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
 * Generate a comment-form CSRF token bound to the target content ID rather
 * than the (often missing) referer URL. This lets the form survive being
 * rendered in cached HTML and lets users coming from email/RSS still post
 * comments. Token = sha256(secret + '&cid=' + cid).
 *
 * The legacy referer-based form is preserved on the verify path for
 * cached pages still in the wild.
 */
export async function generateCommentToken(secret: string, cidOrRefererUrl: string | number): Promise<string> {
  const subject = typeof cidOrRefererUrl === 'number'
    ? `&cid=${cidOrRefererUrl}`
    : `&${cidOrRefererUrl}`;
  return await sha256(`${secret}${subject}`);
}

/**
 * Validate a comment form CSRF token.
 *
 * Accepts either the new cid-bound token or, for short-term backwards
 * compatibility, the legacy referer-bound token. Pages cached before the
 * upgrade still validate; new pages always emit cid-bound tokens.
 */
export async function validateCommentToken(
  token: string,
  secret: string,
  cid: number,
  refererUrl?: string,
): Promise<boolean> {
  const expectedCid = await generateCommentToken(secret, cid);
  if (timeSafeEqual(token, expectedCid)) return true;
  if (refererUrl) {
    const expectedReferer = await generateCommentToken(secret, refererUrl);
    if (timeSafeEqual(token, expectedReferer)) return true;
  }
  return false;
}

// ---- Utilities ----

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns false if strings differ in length (without leaking which bytes differ).
 */
function timeSafeEqual(a: string, b: string): boolean {
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
 * Decide whether to emit the `Secure` cookie attribute. Production deploys
 * always run on HTTPS via Cloudflare, but `pnpm run dev` exposes the worker
 * over plain http://localhost. Marking cookies Secure on http drops them.
 */
export function shouldUseSecureCookie(request?: Request): boolean {
  if (!request) return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
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
