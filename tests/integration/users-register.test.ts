/**
 * Integration test for /api/users/register (G1-5).
 *
 * - allowRegister=0 → 403
 * - cross-origin POST → 403
 * - same-origin success → 302 to /admin/login WITHOUT auth cookies
 *   (no auto-login closes the session-fixation surface)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { POST } from '@/pages/api/users/register';

const SITE_URL = 'https://example.com';

async function seedRegistrationOpen() {
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE_URL });
  await testDb.insert(schema.options).values({ name: 'allowRegister', user: 0, value: '1' });
  await testDb.insert(schema.options).values({ name: 'secret', user: 0, value: 's' });
}

function buildRequest(opts: { origin?: string; body: Record<string, string> }) {
  const body = new URLSearchParams(opts.body).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  return new Request(`${SITE_URL}/api/users/register`, {
    method: 'POST',
    headers,
    body,
  });
}

describe('users/register endpoint (G1-5)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('rejects when registration is closed', async () => {
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE_URL });
    await testDb.insert(schema.options).values({ name: 'allowRegister', user: 0, value: '0' });
    const response = await POST({
      request: buildRequest({ origin: SITE_URL, body: { name: 'bob', mail: 'b@b.com', password: 'secret123' } }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
  });

  it('rejects cross-origin POSTs', async () => {
    await seedRegistrationOpen();
    const response = await POST({
      request: buildRequest({ origin: 'https://evil.com', body: { name: 'bob', mail: 'b@b.com', password: 'secret123' } }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
  });

  it('redirects to /admin/login without auto-login on success', async () => {
    await seedRegistrationOpen();
    const response = await POST({
      request: buildRequest({ origin: SITE_URL, body: { name: 'bob', mail: 'b@b.com', password: 'secret123' } }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/login');
    const setCookie = response.headers.get('Set-Cookie') || '';
    expect(setCookie).not.toContain('__typecho_uid=');
    expect(setCookie).toContain('__typecho_register_notice=');

    const created = await testDb.query.users.findFirst({ where: eq(schema.users.name, 'bob') });
    expect(created).toBeTruthy();
    expect(created!.group).toBe('subscriber');
  });

  it('rejects duplicate username', async () => {
    await seedRegistrationOpen();
    await POST({
      request: buildRequest({ origin: SITE_URL, body: { name: 'bob', mail: 'b1@b.com', password: 'secret123' } }),
      locals: {},
    } as any);
    const dup = await POST({
      request: buildRequest({ origin: SITE_URL, body: { name: 'bob', mail: 'b2@b.com', password: 'secret123' } }),
      locals: {},
    } as any);
    expect(dup.status).toBe(409);
  });

  it('rejects malformed email', async () => {
    await seedRegistrationOpen();
    const response = await POST({
      request: buildRequest({ origin: SITE_URL, body: { name: 'cara', mail: 'not-an-email', password: 'secret123' } }),
      locals: {},
    } as any);
    expect(response.status).toBe(400);
  });
});
