/**
 * Integration tests for POST /api/admin/profile
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { hashPassword, generateRandomString } from '@/lib/auth';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/profile';

const SECRET = 'test-secret-p';
const AUTH_CODE = 'authcodeprof';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/admin/profile', () => {
  it('returns 401 without auth cookie', async () => {
    const formData = new URLSearchParams({ screenName: 'Test', mail: 'test@example.com' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when mail is empty', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({ screenName: 'New Name' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({ mail: 'not-an-email' });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('updates screenName and mail successfully', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      screenName: 'Updated Admin',
      mail: 'newadmin@example.com',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const user = await testDb.query.users.findFirst();
    expect(user!.screenName).toBe('Updated Admin');
    expect(user!.mail).toBe('newadmin@example.com');
  });

  it('updates password when provided', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      password: 'newpassword123',
      passwordConfirm: 'newpassword123',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const user = await testDb.query.users.findFirst();
    expect(user!.password).not.toBeNull();
    expect(user!.password).toContain('$PBKDF2$');
  });

  it('rejects password change when confirmation does not match', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      password: 'newpassword123',
      passwordConfirm: 'different',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('rejects short password', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      password: '12345',
      passwordConfirm: '12345',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('updates url field', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      url: 'https://myblog.example.com',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const user = await testDb.query.users.findFirst();
    expect(user!.url).toBe('https://myblog.example.com/');
  });

  it('rejects invalid url', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const formData = new URLSearchParams({
      mail: 'admin@example.com',
      url: 'javascript:alert(1)',
    });
    const req = new Request('https://example.com/api/admin/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: formData.toString(),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });
});
