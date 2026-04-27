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
 * Hash a password using PBKDF2 with a random salt (Cloudflare Workers compatible).
 * Output format: $PBKDF2$iterations$salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  const iterations = 100000;
  const salt = generateSalt(16);
  const hash = await pbkdf2Hash(password, salt, iterations);
  return `$PBKDF2$${iterations}$${salt}$${hash}`;
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
 * Generate a CSRF security token (matches Typecho's Security widget)
 */
export async function generateSecurityToken(secret: string, authCode: string, uid: number): Promise<string> {
  return await sha256(`${secret}${authCode}${uid}`);
}

/**
 * Validate CSRF token
 */
export async function validateSecurityToken(
  token: string,
  secret: string,
  authCode: string,
  uid: number
): Promise<boolean> {
  const expected = await generateSecurityToken(secret, authCode, uid);
  return timeSafeEqual(token, expected);
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
 * Priority: form data _ field > query string _ param > JSON body _ field
 */
async function extractAdminCSRFToken(request: Request): Promise<string | null> {
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
 * Generate a comment form CSRF token for anonymous users.
 * Matches Typecho's Security::getToken(referer): md5(secret + '&' + referer)
 * We use SHA-256 instead of MD5 for stronger security.
 */
export async function generateCommentToken(secret: string, refererUrl: string): Promise<string> {
  return await sha256(`${secret}&${refererUrl}`);
}

/**
 * Validate a comment form CSRF token.
 */
export async function validateCommentToken(
  token: string,
  secret: string,
  refererUrl: string,
): Promise<boolean> {
  const expected = await generateCommentToken(secret, refererUrl);
  return timeSafeEqual(token, expected);
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

export function getAuthCookies(cookieHeader: string | null): { token: string | null } {
  if (!cookieHeader) return { token: null };
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...vals] = c.trim().split('=');
      return [key, vals.join('=')];
    })
  );
  const uid = cookies[AUTH_COOKIE_NAME];
  const code = cookies[AUTH_CODE_COOKIE_NAME];
  if (uid && code) {
    return { token: `${uid}:${code}` };
  }
  return { token: null };
}

export function setAuthCookieHeaders(uid: number, hash: string, maxAge = 30 * 24 * 3600): string[] {
  const base = 'Path=/; HttpOnly; Secure; SameSite=Lax';
  const opts = maxAge > 0 ? `${base}; Max-Age=${maxAge}` : base;
  return [
    `${AUTH_COOKIE_NAME}=${uid}; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=${hash}; ${opts}`,
  ];
}

export function clearAuthCookieHeaders(): string[] {
  const opts = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  return [
    `${AUTH_COOKIE_NAME}=; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=; ${opts}`,
  ];
}
