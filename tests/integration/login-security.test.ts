/**
 * Integration tests for /api/users/login covering G1-3 brute-force lockout,
 * G1-4 referer redirect allowlist, and G1-6 transparent password rehash.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { hashPassword, PBKDF2_ITERATIONS } from '@/lib/auth';
import { resetLoginRateLimit } from '@/lib/login-rate-limit';
import { schema } from '@/db';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { POST } from '@/pages/api/users/login';

const SITE_URL = 'https://example.com';

async function seedSite(secretValue = 'sekret') {
  await testDb.insert(schema.options).values({ name: 'secret', user: 0, value: secretValue });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE_URL });
  await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
}

async function seedUser(password: string, opts: { group?: string; iterations?: number } = {}) {
  let hash = await hashPassword(password);
  if (opts.iterations) {
    // Rebuild with explicit iteration count (used to simulate legacy 100k hashes).
    const parts = hash.split('$');
    parts[2] = String(opts.iterations);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(parts[3]), iterations: opts.iterations, hash: 'SHA-256' },
      keyMaterial,
      256,
    );
    parts[4] = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
    hash = parts.join('$');
  }
  await testDb.insert(schema.users).values({
    name: 'alice',
    mail: 'alice@example.com',
    password: hash,
    group: opts.group || 'administrator',
    authCode: 'auth-1',
  });
}

function makeRequest(opts: { ip?: string; origin?: string; body: Record<string, string> }) {
  const body = new URLSearchParams(opts.body).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.ip !== undefined) headers['cf-connecting-ip'] = opts.ip;
  return new Request(`${SITE_URL}/api/users/login`, {
    method: 'POST',
    headers,
    body,
  });
}

describe('login security', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    resetLoginRateLimit();
  });

  it('locks out after repeated wrong passwords from the same IP (G1-3)', async () => {
    await seedSite();
    await seedUser('correct-password');

    const tries: Response[] = [];
    for (let i = 0; i < 6; i++) {
      tries.push(await POST({
        request: makeRequest({ ip: '9.9.9.9', origin: SITE_URL, body: { name: 'alice', password: 'wrong' } }),
        locals: {},
      } as any));
    }

    // After exceeding maxFailures the response should signal a lock.
    const last = tries[tries.length - 1];
    expect(last.status).toBe(302);
    expect(last.headers.get('Retry-After')).toBeTruthy();
    expect(last.headers.get('Set-Cookie')).toContain('__typecho_login_error=');

    // Even with the right password, the IP stays locked.
    const correctButLocked = await POST({
      request: makeRequest({ ip: '9.9.9.9', origin: SITE_URL, body: { name: 'alice', password: 'correct-password' } }),
      locals: {},
    } as any);
    expect(correctButLocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('does not lock IPs that succeed before exceeding the threshold (G1-3)', async () => {
    await seedSite();
    await seedUser('correct-password');

    // 2 failures, then a success — counter should reset.
    for (let i = 0; i < 2; i++) {
      await POST({
        request: makeRequest({ ip: '8.8.8.8', origin: SITE_URL, body: { name: 'alice', password: 'wrong' } }),
        locals: {},
      } as any);
    }

    const success = await POST({
      request: makeRequest({ ip: '8.8.8.8', origin: SITE_URL, body: { name: 'alice', password: 'correct-password' } }),
      locals: {},
    } as any);
    expect(success.status).toBe(302);
    expect(success.headers.get('Set-Cookie')).toContain('__typecho_uid=');
    expect(success.headers.get('Retry-After')).toBeNull();
  });

  it('rejects cross-origin POSTs (G2-5)', async () => {
    await seedSite();
    await seedUser('correct-password');

    const response = await POST({
      request: makeRequest({ ip: '1.1.1.1', origin: 'https://evil.com', body: { name: 'alice', password: 'correct-password' } }),
      locals: {},
    } as any);

    expect(response.status).toBe(403);
  });

  it('post-login redirect is restricted to /admin/* (G1-4)', async () => {
    await seedSite();
    await seedUser('correct-password');

    const response = await POST({
      request: makeRequest({
        ip: '7.7.7.7',
        origin: SITE_URL,
        body: { name: 'alice', password: 'correct-password', referer: '/' },
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/');
  });

  it('post-login redirect honours legitimate /admin paths (G1-4)', async () => {
    await seedSite();
    await seedUser('correct-password');

    const response = await POST({
      request: makeRequest({
        ip: '7.7.7.8',
        origin: SITE_URL,
        body: { name: 'alice', password: 'correct-password', referer: '/admin/manage-posts' },
      }),
      locals: {},
    } as any);
    expect(response.headers.get('Location')).toBe('/admin/manage-posts');
  });

  it('post-login redirect rejects open-redirect attempts (G1-4)', async () => {
    await seedSite();
    await seedUser('correct-password');

    const response = await POST({
      request: makeRequest({
        ip: '7.7.7.9',
        origin: SITE_URL,
        body: { name: 'alice', password: 'correct-password', referer: '//evil.com/admin/' },
      }),
      locals: {},
    } as any);
    expect(response.headers.get('Location')).toBe('/admin/');
  });

  it('opportunistically rehashes legacy 100k passwords on success (G1-6)', async () => {
    await seedSite();
    await seedUser('correct-password', { iterations: 100_000 });

    const response = await POST({
      request: makeRequest({
        ip: '6.6.6.6',
        origin: SITE_URL,
        body: { name: 'alice', password: 'correct-password' },
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);

    const updated = await testDb.query.users.findFirst({ where: eq(schema.users.name, 'alice') });
    expect(updated).toBeTruthy();
    const stored = updated!.password!;
    const parts = stored.split('$');
    expect(parseInt(parts[2], 10)).toBe(PBKDF2_ITERATIONS);
  });
});
