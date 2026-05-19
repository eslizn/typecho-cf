/**
 * Integration tests for POST /api/admin/plugin-action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { registerPlugin, addHook, HookPoints } from '@/lib/plugin';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/plugin-action';

const SECRET = 'test-secret-pa';
const AUTH_CODE = 'authcodepluga';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
  await testDb.insert(schema.options).values({
    name: 'activatedPlugins', user: 0, value: JSON.stringify(['typecho-plugin-test']),
  });

  // Register plugin
  registerPlugin('typecho-plugin-test', {
    id: 'typecho-plugin-test',
    name: 'Test Plugin',
  });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/admin/plugin-action', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plugin: 'test', action: 'test' }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing plugin or action', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid plugin ID format', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plugin: 'invalid plugin name!', action: 'test' }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
  });

  it('returns 403 for inactive plugin', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plugin: 'typecho-plugin-inactive', action: 'test' }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(403);
  });

  it('dispatches action to plugin hook and returns result', async () => {
    addHook('plugin:typecho-plugin-test:action', 'typecho-plugin-test', async (result: any, extra: any) => {
      if (extra?.action === 'sync') {
        return { handled: true, success: true, message: 'Sync completed' };
      }
      return result;
    });

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plugin: 'typecho-plugin-test', action: 'sync', payload: {} }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('Sync completed');
  });

  it('returns 404 when plugin does not handle the action', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plugin: 'typecho-plugin-test', action: 'unknown', payload: {} }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: 'not json',
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
  });
});
