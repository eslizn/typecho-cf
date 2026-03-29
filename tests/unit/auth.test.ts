/**
 * Unit tests for src/lib/auth.ts
 *
 * Tests password hashing/verification, permission checks, cookie helpers,
 * and auth token generation/validation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  hasPermission,
  hashPassword,
  verifyPassword,
  generateAuthToken,
  validateAuthToken,
  generateRandomString,
  getAuthCookies,
  setAuthCookieHeaders,
  clearAuthCookieHeaders,
} from '@/lib/auth';

// ---------------------------------------------------------------------------
// hasPermission
// ---------------------------------------------------------------------------
describe('hasPermission()', () => {
  it('administrator passes administrator check', () => {
    expect(hasPermission('administrator', 'administrator')).toBe(true);
  });

  it('administrator passes editor check (higher privilege)', () => {
    expect(hasPermission('administrator', 'editor')).toBe(true);
  });

  it('administrator passes subscriber check', () => {
    expect(hasPermission('administrator', 'subscriber')).toBe(true);
  });

  it('editor fails administrator check (lower privilege)', () => {
    expect(hasPermission('editor', 'administrator')).toBe(false);
  });

  it('visitor fails administrator check', () => {
    expect(hasPermission('visitor', 'administrator')).toBe(false);
  });

  it('visitor passes visitor check', () => {
    expect(hasPermission('visitor', 'visitor')).toBe(true);
  });

  it('strict mode: administrator fails editor check (different level)', () => {
    expect(hasPermission('administrator', 'editor', true)).toBe(false);
  });

  it('strict mode: editor passes editor check (same level)', () => {
    expect(hasPermission('editor', 'editor', true)).toBe(true);
  });

  it('unknown group treated as visitor (level 4)', () => {
    expect(hasPermission('unknown', 'visitor')).toBe(true);
    expect(hasPermission('unknown', 'administrator')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------
describe('hashPassword() / verifyPassword()', () => {
  it('hashes password in $SHA256$salt$hash format', async () => {
    const hash = await hashPassword('mypassword');
    expect(hash).toMatch(/^\$SHA256\$[a-z0-9]+\$[a-f0-9]{64}$/);
  });

  it('verifies correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces different hashes for same password (random salt)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });

  it('returns false for non-SHA256 hash format', async () => {
    expect(await verifyPassword('password', 'md5hash')).toBe(false);
  });

  it('returns false for malformed $SHA256$ hash (wrong segment count)', async () => {
    expect(await verifyPassword('password', '$SHA256$onlytwoparts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateRandomString
// ---------------------------------------------------------------------------
describe('generateRandomString()', () => {
  it('generates string of correct length', () => {
    expect(generateRandomString(16)).toHaveLength(16);
    expect(generateRandomString(32)).toHaveLength(32);
  });

  it('generates different strings on each call', () => {
    const a = generateRandomString(16);
    const b = generateRandomString(16);
    expect(a).not.toBe(b);
  });

  it('only contains alphanumeric characters', () => {
    const s = generateRandomString(100);
    expect(s).toMatch(/^[a-zA-Z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// generateAuthToken / validateAuthToken
// ---------------------------------------------------------------------------
describe('generateAuthToken() / validateAuthToken()', () => {
  const secret = 'test-secret-key';
  const mockUser = {
    uid: 42,
    name: 'testuser',
    password: 'hash',
    mail: 'test@example.com',
    url: null,
    screenName: 'Test User',
    created: 0,
    activated: 0,
    logged: 0,
    group: 'administrator',
    authCode: 'myauthcode',
  };

  it('generates a valid token and validateAuthToken returns user', async () => {
    const token = await generateAuthToken(42, 'myauthcode', secret);
    expect(token).toMatch(/^42:[a-f0-9]{64}$/);

    const mockDb = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue(mockUser),
        },
      },
    } as any;

    const result = await validateAuthToken(token, secret, mockDb);
    expect(result).not.toBeNull();
    expect(result!.uid).toBe(42);
    expect(result!.user.name).toBe('testuser');
  });

  it('returns null for token with wrong hash', async () => {
    const mockDb = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue(mockUser),
        },
      },
    } as any;

    const result = await validateAuthToken('42:wronghash', secret, mockDb);
    expect(result).toBeNull();
  });

  it('returns null for token with invalid format', async () => {
    const mockDb = { query: { users: { findFirst: vi.fn() } } } as any;
    expect(await validateAuthToken('invalid', secret, mockDb)).toBeNull();
    expect(await validateAuthToken('abc:hash', secret, mockDb)).toBeNull();
  });

  it('returns null when user is not found in DB', async () => {
    const token = await generateAuthToken(99, 'code', secret);
    const mockDb = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
    } as any;
    expect(await validateAuthToken(token, secret, mockDb)).toBeNull();
  });

  it('returns null when user has no authCode', async () => {
    const token = await generateAuthToken(42, 'code', secret);
    const mockDb = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue({ ...mockUser, authCode: null }),
        },
      },
    } as any;
    expect(await validateAuthToken(token, secret, mockDb)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
describe('getAuthCookies()', () => {
  it('returns token when both cookies are present', () => {
    const header = '__typecho_uid=42; __typecho_authCode=abc123def';
    const { token } = getAuthCookies(header);
    expect(token).toBe('42:abc123def');
  });

  it('returns null token when cookie header is null', () => {
    expect(getAuthCookies(null).token).toBeNull();
  });

  it('returns null when only uid cookie is present', () => {
    expect(getAuthCookies('__typecho_uid=42').token).toBeNull();
  });

  it('returns null when only authCode cookie is present', () => {
    expect(getAuthCookies('__typecho_authCode=abc').token).toBeNull();
  });

  it('handles cookies with = in value', () => {
    const header = '__typecho_uid=42; __typecho_authCode=abc=def==';
    const { token } = getAuthCookies(header);
    expect(token).toBe('42:abc=def==');
  });
});

describe('setAuthCookieHeaders()', () => {
  it('returns two cookie headers', () => {
    const headers = setAuthCookieHeaders(1, 'hashvalue');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('__typecho_uid=1');
    expect(headers[1]).toContain('__typecho_authCode=hashvalue');
  });

  it('sets Max-Age when maxAge > 0', () => {
    const headers = setAuthCookieHeaders(1, 'hash', 3600);
    expect(headers[0]).toContain('Max-Age=3600');
  });

  it('does not set Max-Age when maxAge is 0 (session cookie)', () => {
    const headers = setAuthCookieHeaders(1, 'hash', 0);
    expect(headers[0]).not.toContain('Max-Age');
  });
});

describe('clearAuthCookieHeaders()', () => {
  it('returns two cookie headers with Max-Age=0', () => {
    const headers = clearAuthCookieHeaders();
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('Max-Age=0');
    expect(headers[1]).toContain('Max-Age=0');
  });
});
