/**
 * Integration tests for /api/admin/plugin-config (GET + POST)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import {
  addHook,
  registerPlugin,
  removePluginHooks,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';

let testDb: TestDatabase;
let mockPluginCtx: HookContext;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { GET, POST } from '@/pages/api/admin/plugin-config';

const SECRET = 'test-secret-pc';
const AUTH_CODE = 'authcodeplugc';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });

  registerPlugin('typecho-plugin-test', {
    id: 'typecho-plugin-test',
    name: 'Test Plugin',
    config: {
      apiEndpoint: { type: 'text', label: 'API Endpoint', default: 'https://default.example.com' },
      enableFeature: { type: 'checkbox', label: 'Enable Feature', default: [] },
    },
  });

  // Activate plugin
  await testDb.insert(schema.options).values({
    name: 'activatedPlugins', user: 0, value: JSON.stringify(['typecho-plugin-test']),
  });
  mockPluginCtx = { activatedPlugins: new Set<string>() };
  await setActivatedPlugins(mockPluginCtx, ['typecho-plugin-test']);
});

afterEach(async () => {
  removePluginHooks('typecho-plugin-validation-fixture');
  removePluginHooks('typecho-plugin-timeout-fixture');
  vi.useRealTimers();
  await disposeTestDb(testDb);
});

describe('GET /api/admin/plugin-config', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/plugin-config?id=test');
    const res = await GET({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns plugin config with defaults when no saved values', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config?id=typecho-plugin-test', {
      headers: { cookie },
    });
    const res = await GET({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);

    const body = await res.json<{ plugin: string; fields: unknown; values: Record<string, unknown> }>();
    expect(body.plugin).toBe('typecho-plugin-test');
    expect(body.fields).toBeDefined();
    expect(body.values.apiEndpoint).toBe('https://default.example.com');
  });

  it('returns 404 for plugin without config', async () => {
    registerPlugin('typecho-plugin-noconfig', {
      id: 'typecho-plugin-noconfig',
      name: 'No Config Plugin',
    });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config?id=typecho-plugin-noconfig', {
      headers: { cookie },
    });
    const res = await GET({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/plugin-config', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plugin: 'test', settings: {} }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(401);
  });

  it('saves plugin config successfully', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({
        plugin: 'typecho-plugin-test',
        settings: { apiEndpoint: 'https://custom.example.com', enableFeature: ['notify'] },
      }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(200);

    const body = await res.json<{ success: boolean }>();
    expect(body.success).toBe(true);

    const saved = await testDb.query.options.findFirst({
      where: (t, { eq, and }) => and(eq(t.name, 'plugin:typecho-plugin-test'), eq(t.user, 0)),
    });
    expect(saved).not.toBeNull();
    const parsed = JSON.parse(saved!.value!);
    expect(parsed.apiEndpoint).toBe('https://custom.example.com');
  });

  it('returns 404 for non-existent plugin', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'nonexistent', settings: {} }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(404);
  });

  it('returns 400 for inactive plugin', async () => {
    registerPlugin('typecho-plugin-inactive', {
      id: 'typecho-plugin-inactive',
      name: 'Inactive Plugin',
      config: { key: { type: 'text', label: 'Key' } },
    });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'typecho-plugin-inactive', settings: { key: 'val' } }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing settings', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: 'typecho-plugin-test' }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: 'not json',
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
  });

  it('returns the plugin validation error without persisting settings', async () => {
    const pluginId = 'typecho-plugin-validation-fixture';
    registerPlugin(pluginId, {
      id: pluginId,
      name: 'Validation Fixture',
      config: { key: { type: 'text', label: 'Key' } },
    });
    addHook('plugin:config:beforeSave', pluginId, async () => ({
      success: false,
      error: 'fixture rejected',
    }));
    await testDb.insert(schema.options).values({
      name: 'activatedPlugins',
      user: 0,
      value: JSON.stringify(['typecho-plugin-test', pluginId]),
    }).onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: { value: JSON.stringify(['typecho-plugin-test', pluginId]) },
    });

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: pluginId, settings: { key: 'value' } }),
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'fixture rejected' });
    expect(await testDb.query.options.findFirst({
      where: (t, { eq }) => eq(t.name, `plugin:${pluginId}`),
    })).toBeUndefined();
  });

  it('bounds plugin validation time and does not persist timed-out settings', async () => {
    const pluginId = 'typecho-plugin-timeout-fixture';
    registerPlugin(pluginId, {
      id: pluginId,
      name: 'Timeout Fixture',
      config: { key: { type: 'text', label: 'Key' } },
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    addHook('plugin:config:beforeSave', pluginId, () => {
      markStarted();
      return new Promise(() => {});
    });
    await testDb.insert(schema.options).values({
      name: 'activatedPlugins',
      user: 0,
      value: JSON.stringify(['typecho-plugin-test', pluginId]),
    }).onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: { value: JSON.stringify(['typecho-plugin-test', pluginId]) },
    });

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/plugin-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://example.com' },
      body: JSON.stringify({ plugin: pluginId, settings: { key: 'value' } }),
    });
    vi.useFakeTimers();
    const pending = POST({ request: req } as any);
    await started;
    await vi.advanceTimersByTimeAsync(5_001);
    const res = await pending;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '插件配置校验超时，请稍后重试' });
    expect(await testDb.query.options.findFirst({
      where: (t, { eq }) => eq(t.name, `plugin:${pluginId}`),
    })).toBeUndefined();
  });
});
