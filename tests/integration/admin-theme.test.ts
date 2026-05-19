/**
 * Integration tests for POST /api/admin/theme
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { registerPlugin } from '@/lib/plugin';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/theme';

const SECRET = 'test-secret-th';
const AUTH_CODE = 'authcodetheme';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/admin/theme', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'typecho-theme-minimal' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when no theme specified', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({}),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent theme', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ theme: 'nonexistent-theme' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: 'not json',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });
});
