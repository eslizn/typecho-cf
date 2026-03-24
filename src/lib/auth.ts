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
 * Hash a password using SHA-256 with salt (Cloudflare Workers compatible)
 * This replaces Typecho's phpass/PasswordHash
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = generateSalt(16);
  const hash = await sha256(salt + password);
  return `$SHA256$${salt}$${hash}`;
}

/**
 * Verify a password against a stored hash
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('$SHA256$')) {
    // "$SHA256$salt$hash".split('$') => ['', 'SHA256', salt, hash] (length 4)
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const salt = parts[2];
    const hash = parts[3];
    if (!salt || !hash) return false;
    const computed = await sha256(salt + password);
    return hash === computed;
  }
  // Fallback: direct comparison for migration
  return false;
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
  if (hash !== expected) return null;

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
  return token === expected;
}

// ---- Utilities ----

async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(36))
    .join('')
    .substring(0, length);
}

export function generateRandomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => chars[b % chars.length])
    .join('');
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
  const base = 'Path=/; HttpOnly; SameSite=Lax';
  const opts = maxAge > 0 ? `${base}; Max-Age=${maxAge}` : base;
  return [
    `${AUTH_COOKIE_NAME}=${uid}; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=${hash}; ${opts}`,
  ];
}

export function clearAuthCookieHeaders(): string[] {
  const opts = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  return [
    `${AUTH_COOKIE_NAME}=; ${opts}`,
    `${AUTH_CODE_COOKIE_NAME}=; ${opts}`,
  ];
}
