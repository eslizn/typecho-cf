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
          token: { type: 'password', label: 'Token', default: 'manifest-secret' },
          public: { type: 'text', label: 'Public', default: '' },
          credentials: {
            type: 'repeatable',
            label: 'Credentials',
            default: [],
            itemFields: {
              provider: { type: 'text', label: 'Provider', default: '' },
              password: { type: 'password', label: 'Password', default: '' },
              internal: { type: 'hidden', label: 'Internal', default: 'hidden-default' },
            },
          },
          accessTokens: { type: 'tokens', label: 'Access tokens', default: [] },
        },
      },
    } : undefined,
    pluginHasConfig: (id: string) => id === 'plugin-secret-fixture',
    isPluginActive: () => true,
    loadPluginConfig: (options: any, _id: string) => {
      try { return JSON.parse(options['plugin:plugin-secret-fixture'] || '{}'); }
      catch { return {}; }
    },
    getPluginConfigDefaults: () => ({ token: 'manifest-secret', public: '', credentials: [], accessTokens: [] }),
    applyFilter: async (_ctx: any, _hook: string, value: any) => value,
  };
});

import { GET, POST } from '@/pages/api/admin/plugin-config';
import { PLUGIN_CONFIG_ROW_ID } from '@/lib/plugin-config';

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
    await setUp({
      token: 'super-secret-token',
      public: 'visible',
      credentials: [{ provider: 'r2', password: 'nested-secret', internal: 'nested-hidden' }],
    });
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
    const body = await response.json() as {
      values: Record<string, any>;
      fields: Record<string, any>;
    };
    expect(body.values.token).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(body.values.public).toBe('visible');
    expect(body.values.credentials).toEqual([{
      [PLUGIN_CONFIG_ROW_ID]: '0',
      provider: 'r2',
      password: '__PLUGIN_CONFIG_SECRET__',
      internal: '__PLUGIN_CONFIG_SECRET__',
    }]);
    expect(body.fields.token.default).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(body.fields.credentials.itemFields.internal.default).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(JSON.stringify(body)).not.toContain('super-secret-token');
    expect(JSON.stringify(body)).not.toContain('nested-secret');
    expect(JSON.stringify(body)).not.toContain('nested-hidden');
    expect(JSON.stringify(body)).not.toContain('manifest-secret');
    expect(JSON.stringify(body)).not.toContain('hidden-default');
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
          settings: {
            token: '__PLUGIN_CONFIG_SECRET__',
            public: 'updated',
            ignored: 'must-not-save',
            credentials: [{
              provider: 'r2-new',
              password: '__PLUGIN_CONFIG_SECRET__',
              internal: '__PLUGIN_CONFIG_SECRET__',
              ignored: 'nested-must-not-save',
            }],
          },
        }),
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(200);
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    const parsed = JSON.parse(stored!.value!);
    expect(parsed.token).toBe('super-secret-token');
    expect(parsed.public).toBe('updated');
    expect(parsed.ignored).toBeUndefined();
    expect(parsed.credentials).toEqual([{
      provider: 'r2-new',
      password: 'nested-secret',
      internal: 'nested-hidden',
    }]);
    const body = await response.json<{ settings: Record<string, any> }>();
    expect(body.settings.token).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(body.settings.credentials[0].password).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(JSON.stringify(body)).not.toContain('super-secret-token');
    expect(JSON.stringify(body)).not.toContain('nested-secret');
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

  it('preserves nested secrets by stable row identity after rows are reordered', async () => {
    await setUp({
      token: 'top-secret',
      public: 'visible',
      credentials: [
        { provider: 'first', password: 'first-password', internal: 'first-hidden' },
        { provider: 'second', password: 'second-password', internal: 'second-hidden' },
      ],
    });
    const cookie = await adminCookie();
    const csrf = await csrfToken();
    const viewResponse = await GET({
      request: new Request(`${SITE}/api/admin/plugin-config?id=plugin-secret-fixture`, {
        headers: { cookie },
      }),
      url: new URL(`${SITE}/api/admin/plugin-config?id=plugin-secret-fixture`),
      locals: {},
    } as any);
    const view = await viewResponse.json() as { values: { credentials: Record<string, unknown>[] } };
    const [first, second] = view.values.credentials;
    const form = new URLSearchParams({
      _: csrf,
      plugin: 'plugin-secret-fixture',
      token: '__PLUGIN_CONFIG_SECRET__',
      public: 'visible',
      [`credentials[0][${PLUGIN_CONFIG_ROW_ID}]`]: String(second[PLUGIN_CONFIG_ROW_ID]),
      'credentials[0][provider]': 'second',
      'credentials[0][password]': '__PLUGIN_CONFIG_SECRET__',
      'credentials[0][internal]': '__PLUGIN_CONFIG_SECRET__',
      [`credentials[1][${PLUGIN_CONFIG_ROW_ID}]`]: String(first[PLUGIN_CONFIG_ROW_ID]),
      'credentials[1][provider]': 'first',
      'credentials[1][password]': '__PLUGIN_CONFIG_SECRET__',
      'credentials[1][internal]': '__PLUGIN_CONFIG_SECRET__',
    });

    const response = await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(303);
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    expect(JSON.parse(stored!.value!).credentials).toEqual([
      { provider: 'second', password: 'second-password', internal: 'second-hidden' },
      { provider: 'first', password: 'first-password', internal: 'first-hidden' },
    ]);
  });

  it('persists the tokens the form submitted and drops rows without a value', async () => {
    await setUp({
      token: 'top-secret',
      public: 'visible',
      credentials: [],
      accessTokens: [{ id: 't1', token: 'kept-token-0123456789' }],
    });
    const cookie = await adminCookie();
    const csrf = await csrfToken();
    const form = new URLSearchParams({
      _: csrf,
      plugin: 'plugin-secret-fixture',
      token: '__PLUGIN_CONFIG_SECRET__',
      public: 'visible',
      'accessTokens[0][id]': 't1',
      'accessTokens[0][token]': 'kept-token-0123456789',
      'accessTokens[1][id]': 't2',
      'accessTokens[1][token]': '',
      'accessTokens[2][id]': 't3',
      'accessTokens[2][token]': 'client-generated-token-0123456789',
      'credentials[0][provider]': 'r2',
      'credentials[0][password]': '__PLUGIN_CONFIG_SECRET__',
      'credentials[0][internal]': '__PLUGIN_CONFIG_SECRET__',
    });

    const response = await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(303);
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    const tokens = JSON.parse(stored!.value!).accessTokens as Array<{ id: string; token: string }>;
    expect(tokens).toEqual([
      { id: 't1', token: 'kept-token-0123456789' },
      { id: 't3', token: 'client-generated-token-0123456789' },
    ]);
  });

  it('rejects a token list over the cap instead of saving a trimmed one', async () => {
    await setUp({ token: 'top-secret', public: 'visible', credentials: [], accessTokens: [] });
    const cookie = await adminCookie();
    const csrf = await csrfToken();
    const form = new URLSearchParams({
      _: csrf,
      plugin: 'plugin-secret-fixture',
      token: '__PLUGIN_CONFIG_SECRET__',
      public: 'visible',
      'credentials[0][provider]': 'r2',
      'credentials[0][password]': '__PLUGIN_CONFIG_SECRET__',
      'credentials[0][internal]': '__PLUGIN_CONFIG_SECRET__',
    });
    for (let index = 0; index < 21; index += 1) {
      form.set(`accessTokens[${index}][id]`, `t${index}`);
      form.set(`accessTokens[${index}][token]`, `token-${index}-0123456789`);
    }

    const response = await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('20');
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    expect(JSON.parse(stored!.value!).accessTokens).toEqual([]);
  });

  it('stores an empty token list when every row is deleted', async () => {
    await setUp({
      token: 'top-secret',
      public: 'visible',
      credentials: [],
      accessTokens: [{ id: 't1', token: 'kept-token-0123456789' }],
    });
    const cookie = await adminCookie();
    const csrf = await csrfToken();
    const form = new URLSearchParams({
      _: csrf,
      plugin: 'plugin-secret-fixture',
      token: '__PLUGIN_CONFIG_SECRET__',
      public: 'visible',
      'credentials[0][provider]': 'r2',
      'credentials[0][password]': '__PLUGIN_CONFIG_SECRET__',
      'credentials[0][internal]': '__PLUGIN_CONFIG_SECRET__',
    });

    const response = await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(303);
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    expect(JSON.parse(stored!.value!).accessTokens).toEqual([]);
  });

  it('form submissions use the same save path and redirect without exposing secrets', async () => {
    const cookie = await adminCookie();
    const csrf = await csrfToken();
    const form = new URLSearchParams({
      _: csrf,
      plugin: 'plugin-secret-fixture',
      token: '__PLUGIN_CONFIG_SECRET__',
      public: 'from-form',
      'credentials[0][provider]': 'r2-form',
      'credentials[0][password]': '__PLUGIN_CONFIG_SECRET__',
      'credentials[0][internal]': '__PLUGIN_CONFIG_SECRET__',
    });
    const response = await POST({
      request: new Request(`${SITE}/api/admin/plugin-config`, {
        method: 'POST',
        headers: {
          cookie,
          origin: SITE,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      }),
      locals: {},
    } as any);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/plugin-config?id=plugin-secret-fixture&saved=1');
    const stored = await testDb.query.options.findFirst({ where: (o, { eq }) => eq(o.name, 'plugin:plugin-secret-fixture') });
    const parsed = JSON.parse(stored!.value!);
    expect(parsed.public).toBe('from-form');
    expect(parsed.token).toBe('super-secret-token');
    expect(parsed.credentials[0]).toMatchObject({
      provider: 'r2-form',
      password: 'nested-secret',
      internal: 'nested-hidden',
    });
  });
});
