/**
 * Integration tests for POST /api/admin/plugin and POST /api/admin/plugin-action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { registerPlugin, setActivatedPlugins } from '@/lib/plugin';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST, GET } from '@/pages/api/admin/plugin';

const SECRET = 'test-secret-pl';
const AUTH_CODE = 'authcodeplug';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });

  // Register a test plugin
  registerPlugin('typecho-plugin-test', {
    id: 'typecho-plugin-test',
    name: 'Test Plugin',
    description: 'A test plugin',
    config: {
      apiEndpoint: { type: 'text', label: 'API Endpoint', default: '' },
    },
  });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/admin/plugin', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plugin: 'test', action: 'activate' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    await testDb.update(schema.users).set({ group: 'editor' }).where(eq(schema.users.uid, 1));
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'test', action: 'activate' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing plugin ID', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({}),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid action', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'test', action: 'invalid' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent plugin', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'nonexistent', action: 'activate' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(404);
  });

  it('activates a plugin and saves default config', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'typecho-plugin-test', action: 'activate' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.activatedPlugins).toContain('typecho-plugin-test');

    // Check default config was saved
    const configRow = await testDb.query.options.findFirst({
      where: (t, { eq, and }) => and(eq(t.name, 'plugin:typecho-plugin-test'), eq(t.user, 0)),
    });
    expect(configRow).not.toBeNull();
  });

  it('deactivates a plugin and removes config', async () => {
    // First activate
    await testDb.insert(schema.options).values({
      name: 'plugin:typecho-plugin-test', user: 0, value: JSON.stringify({ apiEndpoint: 'https://api.example.com' }),
    });
    await testDb.insert(schema.options).values({
      name: 'activatedPlugins', user: 0, value: JSON.stringify(['typecho-plugin-test']),
    });
    setActivatedPlugins(['typecho-plugin-test']);

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'typecho-plugin-test', action: 'deactivate' }),
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.activatedPlugins).not.toContain('typecho-plugin-test');

    // Config should be deleted
    const configRow = await testDb.query.options.findFirst({
      where: (t, { eq, and }) => and(eq(t.name, 'plugin:typecho-plugin-test'), eq(t.user, 0)),
    });
    expect(configRow).toBeUndefined();
  });

  it('returns 400 for malformed JSON', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: 'not json',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/plugin', () => {
  it('lists available plugins with activation status', async () => {
    await testDb.insert(schema.options).values({
      name: 'activatedPlugins', user: 0, value: JSON.stringify(['typecho-plugin-test']),
    });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin', { headers: { cookie } });
    const res = await GET({ request: req, locals: {} } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.plugins).toBeDefined();
    expect(body.plugins.some((p: any) => p.id === 'typecho-plugin-test' && p.isActive)).toBe(true);
  });
});
