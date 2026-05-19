/**
 * G2-1 admin Origin/Referer enforcement.
 *
 * Use admin/options as a representative endpoint; the same belt-and-braces
 * check fires for every requireAdminAction() call site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateSecurityToken } from '@/lib/auth';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { POST } from '@/pages/api/admin/options';
import { schema } from '@/db';

const SITE = 'https://example.com';
const SECRET = 'super-secret';
const AUTH = 'auth-token';

async function setUp() {
  testDb = await createTestDb();
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
  await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
  return await seedAdmin(testDb, { secret: SECRET, authCode: AUTH });
}

async function buildRequest(opts: { origin?: string | null; cookie: string; csrf: string; body?: Record<string, string> }) {
  const body = new URLSearchParams({ _: opts.csrf, ...(opts.body || {}) }).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: opts.cookie,
  };
  if (opts.origin !== null && opts.origin !== undefined) {
    headers.origin = opts.origin;
  }
  return new Request(`${SITE}/api/admin/options`, { method: 'POST', headers, body });
}

describe('admin endpoints reject cross-origin POSTs (G2-1)', () => {
  beforeEach(async () => {
    await setUp();
  });

  it('accepts same-origin POST with valid token', async () => {
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
    const csrf = await generateSecurityToken(SECRET, AUTH, user!.uid);
    const response = await POST({
      request: await buildRequest({ origin: SITE, cookie, csrf }),
      locals: {},
    } as any);
    expect(response.status).toBe(302); // redirect on save
  });

  it('rejects cross-origin POST even when CSRF token is valid', async () => {
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
    const csrf = await generateSecurityToken(SECRET, AUTH, user!.uid);
    const response = await POST({
      request: await buildRequest({ origin: 'https://evil.com', cookie, csrf }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
  });

  it('rejects POST with no Origin and no Referer (bare cross-site form)', async () => {
    const user = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
    const csrf = await generateSecurityToken(SECRET, AUTH, user!.uid);
    const response = await POST({
      request: await buildRequest({ origin: null, cookie, csrf }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
  });
});
