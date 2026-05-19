/**
 * Plugin-config secret-masking tests (G3-2).
 *
 * GET should never return raw password/hidden values; POST with the
 * placeholder should preserve the previously stored secret.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateSecurityToken } from '@/lib/auth';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('@/lib/plugin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plugin')>('@/lib/plugin');
  return {
    ...actual,
    getPlugin: (id: string) => id === 'plugin-secret-fixture' ? {
      id,
      packageName: id,
      isActive: true,
      manifest: {
        id,
        name: 'Fixture',
        config: {
          token: { type: 'password', label: 'Token', default: '' },
          public: { type: 'text', label: 'Public', default: '' },
        },
      },
    } : undefined,
    pluginHasConfig: (id: string) => id === 'plugin-secret-fixture',
    isPluginActive: () => true,
    loadPluginConfig: (options: any, _id: string) => {
      try { return JSON.parse(options['plugin:plugin-secret-fixture'] || '{}'); }
      catch { return {}; }
    },
    getPluginConfigDefaults: () => ({ token: '', public: '' }),
    applyFilter: async (_hook: string, value: any) => value,
  };
});

import { GET, POST } from '@/pages/api/admin/plugin-config';

const SITE = 'https://example.com';
const SECRET = 'plugin-cfg-secret';
const AUTH = 'plugin-cfg-auth';

async function setUp(initialPluginConfig?: Record<string, unknown>) {
  testDb = await createTestDb();
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
  await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
  if (initialPluginConfig) {
    await testDb.insert(schema.options).values({
      name: 'plugin:plugin-secret-fixture',
      user: 0,
      value: JSON.stringify(initialPluginConfig),
    });
  }
  return await seedAdmin(testDb, { secret: SECRET, authCode: AUTH });
}

async function adminCookie() {
  const user = await testDb.query.users.findFirst();
  return await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
}

async function csrfToken() {
  const user = await testDb.query.users.findFirst();
  return await generateSecurityToken(SECRET, AUTH, user!.uid);
}

describe('plugin-config secret masking (G3-2)', () => {
  beforeEach(async () => {
    await setUp({ token: 'super-secret-token', public: 'visible' });
  });

  it('GET returns placeholder for password fields, plaintext for others', async () => {
    const cookie = await adminCookie();
    const response = await GET({
      request: new Request(`${SITE}/api/admin/plugin-config?id=plugin-secret-fixture`, {
        method: 'GET',
        headers: { cookie },
      }),
      url: new URL(`${SITE}/api/admin/plugin-config?id=plugin-secret-fixture`),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    const body = await response.json() as { values: Record<string, unknown> };
    expect(body.values.token).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(body.values.public).toBe('visible');
  });

  it('POST with placeholder keeps the previously stored secret', async () => {
    const cookie = await adminCookie();
    const csrf = await csrfToken();

    const response = await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: {
          cookie,
          origin: SITE,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          _: csrf,
          plugin: 'plugin-secret-fixture',
          settings: { token: '__PLUGIN_CONFIG_SECRET__', public: 'updated' },
        }),
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    const parsed = JSON.parse(stored!.value!);
    expect(parsed.token).toBe('super-secret-token');
    expect(parsed.public).toBe('updated');
  });

  it('POST with new value overwrites the secret', async () => {
    const cookie = await adminCookie();
    const csrf = await csrfToken();

    await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: {
          cookie,
          origin: SITE,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          _: csrf,
          plugin: 'plugin-secret-fixture',
          settings: { token: 'rotated-token', public: 'visible' },
        }),
      }),
      locals: {},
    } as any);

    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    const parsed = JSON.parse(stored!.value!);
    expect(parsed.token).toBe('rotated-token');
  });
});
