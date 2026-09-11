import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAuthToken, generateSecurityToken, hashPassword } from '@/lib/auth';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { normalizeHookPoint } from '@/lib/plugin';
import type { PluginRouteClaim, PluginRouteResolverContext } from 'typecho/plugin-sdk';
import init, {
  clearWebDavAuthFailures,
  getWebDavClientIp,
  isWebDavClientBanned,
  matchWebDavRoute,
  normalizeConfig,
  normalizeRoutePath,
  parseBasicCredentials,
  parseMounts,
  recordWebDavAuthFailure,
  resolveWebDavTarget,
  hasExplicitSessionCookie,
  clearTianyiSessionCache,
  tianyiEnsureSession,
  tianyiListFiles,
} from './index';

const VALID_MOUNTS = [
  {
    mount: 'media',
    provider: 'r2',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    bucket: 'media-bucket',
    region: 'auto',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    bindingName: 'BUCKET',
    prefix: 'uploads/',
    pathStyle: true,
  },
];

class MemoryR2Bucket {
  objects = new Map<string, any>();

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...object,
      body: object.body,
    };
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { ...object } : null;
  }

  async put(key: string, body: BodyInit | null, options?: { httpMetadata?: Record<string, string> }) {
    this.objects.set(key, {
      key,
      body: typeof body === 'string' ? body : '',
      size: typeof body === 'string' ? body.length : 0,
      etag: `"${key}"`,
      httpEtag: `"${key}"`,
      uploaded: new Date('2026-05-06T00:00:00.000Z'),
      httpMetadata: options?.httpMetadata,
    });
    return null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async list(options?: { prefix?: string; delimiter?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix || '';
    const delimiter = options?.delimiter;
    const objects: any[] = [];
    const delimitedPrefixes = new Set<string>();

    for (const object of this.objects.values()) {
      if (!object.key.startsWith(prefix)) continue;
      const rest = object.key.slice(prefix.length);
      if (delimiter && rest) {
        const index = rest.indexOf(delimiter);
        if (index >= 0) {
          delimitedPrefixes.add(`${prefix}${rest.slice(0, index + 1)}`);
          continue;
        }
      }
      objects.push(object);
    }

    return {
      objects,
      delimitedPrefixes: [...delimitedPrefixes],
      truncated: false,
      cursor: undefined,
    };
  }
}

let tianyiTestPublicKey = '';

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const bytes = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  tianyiTestPublicKey = btoa(binary);
});

function createTianyiMount(username = '13800138000', password = 'test-password') {
  return parseMounts([{
    mount: 'cloud', provider: 'tianyi', username, password, rootDir: '-11',
  }])[0];
}

function mockTianyiFetch() {
  let loginCount = 0;
  let invalidateNextList = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/portal/loginUrl.action')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://open.e.189.cn/login?lt=test-lt&reqId=test-req&appId=test-app' },
      });
    }
    if (url.startsWith('https://open.e.189.cn/login?')) return new Response('login page');
    if (url.includes('/api/logbox/oauth2/appConf.do')) {
      return Response.json({
        result: 0,
        data: { accountType: '01', returnUrl: 'https://cloud.189.cn/web/main', clientType: '10010', isOauth2: 'false' },
      });
    }
    if (url.includes('/api/logbox/config/encryptConf.do')) {
      return Response.json({ result: 0, data: { pubKey: tianyiTestPublicKey, pre: '' } });
    }
    if (url.includes('/api/logbox/oauth2/loginSubmit.do')) {
      loginCount++;
      return Response.json(
        { result: 0, toUrl: 'https://cloud.189.cn/web/main' },
        { headers: { 'Set-Cookie': `SESSION=session-${loginCount}; Path=/; HttpOnly` } },
      );
    }
    if (url === 'https://cloud.189.cn/web/main') return new Response('main');
    if (url.includes('/api/open/file/listFiles.action')) {
      if (invalidateNextList) {
        invalidateNextList = false;
        return Response.json({ errorCode: 'InvalidSessionKey' });
      }
      return Response.json({ res_code: 0, fileListAO: { fileList: [], folderList: [], count: 0 } });
    }
    throw new Error(`Unexpected Tianyi request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    get loginCount() { return loginCount; },
    invalidateNextSession() { invalidateNextList = true; },
  };
}

function collectHooks() {
  const hooks = new Map<string, Function>();
  let routeResolver: ((context: PluginRouteResolverContext) => ReadonlyArray<PluginRouteClaim>) | undefined;
  init({
    pluginId: 'typecho-plugin-webdav',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
    registerTranslations: () => {},
    registerRouteResolver: (resolver) => {
      routeResolver = resolver;
    },
    registerScheduledTask: () => {},
    registerAsyncTask: () => {},
    enqueueAsyncTask: async () => ({
      jobId: 'test-job',
      taskKey: 'test-task',
      idempotencyKey: 'test-key',
    }),
  });
  const get = hooks.get.bind(hooks);
  hooks.get = ((point: string) => get(normalizeHookPoint(point))) as typeof hooks.get;
  (hooks as Map<string, Function> & { routeResolver?: typeof routeResolver }).routeResolver = routeResolver;
  return hooks;
}

async function routeWithAuth(
  request: Request,
  settings: Record<string, unknown>,
  env: Record<string, unknown>,
  userGroup = 'administrator',
  username = 'admin',
) {
  const hooks = collectHooks();
  const route = hooks.get('route:request')!;
  const password = await hashPassword('secret');
  return await route({ handled: false }, {
    request,
    path: new URL(request.url).pathname,
    db: {
      query: {
        users: {
          findFirst: async () => ({
            name: username,
            password,
            group: userGroup,
          }),
        },
      },
    },
    options: {
      'plugin:typecho-plugin-webdav': JSON.stringify(settings),
    },
    env,
  });
}

function basicAuth(username = 'admin', password = 'secret'): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

async function routeAdminApiWithAuth(
  path: string,
  settings: Record<string, unknown>,
  env: Record<string, unknown>,
) {
  const hooks = collectHooks();
  const route = hooks.get('route:request')!;
  const secret = 'admin-secret';
  const authCode = 'admin-auth';
  const token = await generateAuthToken(1, authCode, secret);
  return await route({ handled: false }, {
    request: new Request(`https://example.com${path}`, {
      headers: {
        cookie: `__typecho_uid=1; __typecho_authCode=${token.split(':')[1]}`,
      },
    }),
    path: '/api/admin/webdav',
    db: {
      query: {
        users: {
          findFirst: async () => ({
            uid: 1,
            name: 'admin',
            authCode,
            group: 'administrator',
          }),
        },
      },
    },
    options: {
      secret,
      'plugin:typecho-plugin-webdav': JSON.stringify(settings),
    },
    env,
  });
}

describe('typecho-plugin-webdav config', () => {
  it('normalizes the WebDAV route path', () => {
    expect(normalizeRoutePath('dav/')).toBe('/dav');
    expect(normalizeRoutePath('/storage/dav/')).toBe('/storage/dav');
    expect(normalizeRoutePath('/')).toBe('/webdav');
    expect(normalizeRoutePath(undefined)).toBe('/webdav');
  });

  it('matches only the configured route root or descendants', () => {
    expect(matchWebDavRoute('/dav', '/dav')).toBe('');
    expect(matchWebDavRoute('/dav', '/dav/media/a.jpg')).toBe('media/a.jpg');
    expect(matchWebDavRoute('/dav', '/davish/media')).toBeNull();
  });

  it('parses multiple root mounts', () => {
    const mounts = parseMounts(JSON.stringify([
      {
        mount: 'media',
        provider: 'r2',
        bindingName: 'BUCKET',
        prefix: 'uploads/',
      },
      {
        mount: 'backup',
        provider: 's3',
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        bucket: 'backup-bucket',
        region: 'us-east-1',
        accessKeyId: 'ak2',
        secretAccessKey: 'sk2',
        prefix: '',
        pathStyle: false,
      },
    ]));

    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toMatchObject({
      mount: 'media',
      provider: 'r2',
      bindingName: 'BUCKET',
      prefix: 'uploads',
    });
    expect(mounts[1]).toMatchObject({ mount: 'backup', provider: 's3', pathStyle: false });
  });

  it('defaults to mounting the whole bucket at the WebDAV route root', () => {
    const mounts = parseMounts(undefined);

    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      mount: '',
      provider: 'r2',
      bindingName: 'BUCKET',
      prefix: '',
    });
  });

  it('supports mounting a backend at the WebDAV route root', () => {
    const mounts = parseMounts([
      {
        mount: '/',
        provider: 'r2',
        bindingName: 'ROOT_BUCKET',
        prefix: '/uploads/',
      },
    ]);

    expect(mounts[0]).toMatchObject({
      mount: '',
      provider: 'r2',
      bindingName: 'ROOT_BUCKET',
      prefix: 'uploads',
    });

    const config = normalizeConfig({
      routePath: '/dav',
      mounts,
    });
    expect(resolveWebDavTarget(config, '')).toMatchObject({
      mount: mounts[0],
      key: '',
      rootMount: true,
    });
    expect(resolveWebDavTarget(config, 'nested/file.txt')).toMatchObject({
      mount: mounts[0],
      key: 'nested/file.txt',
      rootMount: true,
    });
  });

  it('rejects path traversal via .. segments', () => {
    const config = normalizeConfig({
      routePath: '/dav',
      mounts: [{
        mount: '',
        provider: 'r2',
        bindingName: 'ROOT_BUCKET',
      }],
    });
    expect(resolveWebDavTarget(config, 'a/../b/../secret')).toBeNull();
    expect(resolveWebDavTarget(config, '..')).toBeNull();
    expect(resolveWebDavTarget(config, '.')).toBeNull();
    expect(resolveWebDavTarget(config, 'normal/path/file.txt')).not.toBeNull();
  });

  it('rejects path traversal in named mount subpaths', () => {
    const config = normalizeConfig({
      routePath: '/dav',
      mounts: [{
        mount: 'media',
        provider: 'r2',
        bindingName: 'MEDIA_BUCKET',
      }],
    });
    expect(resolveWebDavTarget(config, 'media/../secret')).toBeNull();
    expect(resolveWebDavTarget(config, 'media/./file.txt')).toBeNull();
    expect(resolveWebDavTarget(config, 'media/subdir/file.txt')).not.toBeNull();
  });

  it('rejects mixing the route root mount with named mounts', () => {
    expect(() => parseMounts([
      {
        mount: '/',
        provider: 'r2',
        bindingName: 'ROOT_BUCKET',
      },
      {
        mount: 'media',
        provider: 'r2',
        bindingName: 'MEDIA_BUCKET',
      },
    ])).toThrow('根目录挂载不能与其他挂载共存');
  });

  it('does not require endpoint or access keys for native R2 bindings', () => {
    expect(parseMounts([
      {
        mount: 'media',
        provider: 'r2',
        bindingName: 'ASSETS_BUCKET',
      },
    ])[0]).toMatchObject({
      mount: 'media',
      provider: 'r2',
      bindingName: 'ASSETS_BUCKET',
    });
  });

  it('rejects duplicate mount roots', () => {
    const mounts = [
      {
        mount: 'media',
        provider: 'r2',
        endpoint: 'https://example.com',
        bucket: 'bucket',
        region: 'auto',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
      },
      {
        mount: 'media',
        provider: 's3',
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        bucket: 'bucket2',
        region: 'us-east-1',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
      },
    ];

    expect(() => parseMounts(JSON.stringify(mounts))).toThrow('挂载目录重复');
  });

  it('rejects empty mount lists', () => {
    expect(() => parseMounts([])).toThrow('至少配置一个后端存储挂载');
  });

  it('normalizes saved settings', () => {
    const config = normalizeConfig({
      routePath: 'webdav/',
      protocolEnabled: 'false',
      mounts: VALID_MOUNTS,
      failBanEnabled: 'true',
      failBanMaxFailures: '3',
      failBanWindowSeconds: '120',
      failBanSeconds: '600',
    });

    expect(config.routePath).toBe('/webdav');
    expect(config.protocolEnabled).toBe(false);
    expect(config.mounts[0].bindingName).toBe('BUCKET');
    expect(config.failBanEnabled).toBe(true);
    expect(config.failBanMaxFailures).toBe(3);
    expect(config.failBanWindowSeconds).toBe(120);
    expect(config.failBanSeconds).toBe(600);
  });

  it('accepts tianyi provider with username and password', () => {
    const mounts = parseMounts(JSON.stringify([{
      mount: 'cloud', provider: 'tianyi', username: '13800138000', password: 'test-password', rootDir: '-11',
    }]));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ mount: 'cloud', provider: 'tianyi', username: '13800138000', password: 'test-password', rootDir: '-11' });
    expect(hasExplicitSessionCookie(mounts[0])).toBe(false);
  });

  it('accepts tianyi provider with session cookie only', () => {
    const mounts = parseMounts(JSON.stringify([{
      mount: 'cloud', provider: 'tianyi', sessionCookie: 'COOKIE_A=aaa; COOKIE_B=bbb',
    }]));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      mount: 'cloud',
      provider: 'tianyi',
      username: '',
      password: '',
      sessionCookie: 'COOKIE_A=aaa; COOKIE_B=bbb',
    });
    expect(hasExplicitSessionCookie(mounts[0])).toBe(true);
  });

  it('rejects tianyi provider without username/password or session cookie', () => {
    expect(() => parseMounts(JSON.stringify([{
      mount: 'cloud', provider: 'tianyi',
    }]))).toThrow('需要填写用户名和密码，或填写已登录的 Cookie');
  });

  it('accepts mixed provider types (r2 + s3 + tianyi)', () => {
    const mounts = parseMounts(JSON.stringify([
      { mount: 'r2mount', provider: 'r2', bindingName: 'BUCKET' },
      { mount: 's3mount', provider: 's3', endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'b', region: 'us-east-1', accessKeyId: 'ak', secretAccessKey: 'sk' },
      { mount: 'cloud', provider: 'tianyi', username: '13800138000', password: 'test-pw' },
    ]));
    expect(mounts).toHaveLength(3);
    expect(mounts.map(m => m.provider)).toEqual(['r2', 's3', 'tianyi']);
  });
});

describe('typecho-plugin-webdav auth parsing', () => {
  it('parses HTTP Basic credentials', () => {
    const token = btoa('admin:secret:with-colon');
    expect(parseBasicCredentials(`Basic ${token}`)).toEqual({
      username: 'admin',
      password: 'secret:with-colon',
    });
  });

  it('returns null for non-basic auth', () => {
    expect(parseBasicCredentials('Bearer token')).toBeNull();
  });

  it('extracts the client IP from proxy headers', () => {
    expect(getWebDavClientIp(new Request('https://example.com/dav', {
      headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20' },
    }))).toBe('203.0.113.10');
    expect(getWebDavClientIp(new Request('https://example.com/dav'))).toBe('unknown');
  });

  it('bans an IP after configured failed login attempts and clears after success', () => {
    const config = normalizeConfig({
      mounts: VALID_MOUNTS,
      failBanEnabled: true,
      failBanMaxFailures: 2,
      failBanWindowSeconds: 60,
      failBanSeconds: 300,
    });
    const ip = '198.51.100.44';
    clearWebDavAuthFailures(ip);

    recordWebDavAuthFailure(config, ip, 1_000);
    expect(isWebDavClientBanned(config, ip, 1_000)).toBe(false);

    recordWebDavAuthFailure(config, ip, 2_000);
    expect(isWebDavClientBanned(config, ip, 2_000)).toBe(true);

    clearWebDavAuthFailures(ip);
    expect(isWebDavClientBanned(config, ip, 2_000)).toBe(false);
  });
});

describe('typecho-plugin-webdav Tianyi session cache', () => {
  beforeEach(() => clearTianyiSessionCache());
  afterEach(() => vi.unstubAllGlobals());

  it('reuses a generated session across fresh mounts and coalesces concurrent logins', async () => {
    const mocked = mockTianyiFetch();

    const [firstCookie, concurrentCookie] = await Promise.all([
      tianyiEnsureSession(createTianyiMount()),
      tianyiEnsureSession(createTianyiMount()),
    ]);
    const laterCookie = await tianyiEnsureSession(createTianyiMount());

    expect(firstCookie).toContain('SESSION=session-1');
    expect(concurrentCookie).toBe(firstCookie);
    expect(laterCookie).toBe(firstCookie);
    expect(mocked.loginCount).toBe(1);
  });

  it('invalidates an expired generated session and logs in again automatically', async () => {
    const mocked = mockTianyiFetch();
    await tianyiEnsureSession(createTianyiMount());
    mocked.invalidateNextSession();

    const result = await tianyiListFiles(createTianyiMount(), '-11');

    expect(result).toEqual({ objects: [], prefixes: [], total: 0 });
    expect(mocked.loginCount).toBe(2);
  });

  it('clears generated sessions when plugin configuration is saved', async () => {
    const mocked = mockTianyiFetch();
    await tianyiEnsureSession(createTianyiMount());

    const configHook = collectHooks().get('plugin:config:beforeSave')!;
    const result = configHook(
      { success: true },
      {
        pluginId: 'typecho-plugin-webdav',
        settings: { mounts: [{ mount: 'cloud', provider: 'tianyi', username: '13800138000', password: 'test-password' }] },
      },
    );
    await tianyiEnsureSession(createTianyiMount());

    expect(result.success).toBe(true);
    expect(mocked.loginCount).toBe(2);
  });
});

describe('typecho-plugin-webdav hooks', () => {
  it('registers config validation, route resolver, and route hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'admin:footer',
      'admin:page',
      'plugin:config:beforeSave',
      'request:route',
    ]);
    expect((hooks as Map<string, Function> & { routeResolver?: Function }).routeResolver).toEqual(expect.any(Function));
  });

  it('claims the default /webdav route as a prefix', () => {
    const hooks = collectHooks();
    const resolver = (hooks as Map<string, Function> & { routeResolver: Function }).routeResolver;

    expect(resolver({ config: {} })).toEqual([
      { path: '/webdav', match: 'prefix' },
    ]);
  });

  it('claims a normalized custom route as a prefix', () => {
    const hooks = collectHooks();
    const resolver = (hooks as Map<string, Function> & { routeResolver: Function }).routeResolver;

    expect(resolver({ config: { routePath: 'storage/dav/' } })).toEqual([
      { path: '/storage/dav', match: 'prefix' },
    ]);
  });

  it('keeps /webdav as a legacy claim when /dav is configured', () => {
    const hooks = collectHooks();
    const resolver = (hooks as Map<string, Function> & { routeResolver: Function }).routeResolver;

    expect(resolver({ config: { routePath: 'dav/' } })).toEqual([
      { path: '/dav', match: 'prefix' },
      { path: '/webdav', match: 'prefix' },
    ]);
  });

  it('claims no protocol route when WebDAV protocol is disabled', () => {
    const hooks = collectHooks();
    const resolver = (hooks as Map<string, Function> & { routeResolver: Function }).routeResolver;

    expect(resolver({ config: { routePath: '/custom', protocolEnabled: false } })).toEqual([]);
  });

  it('normalizes config before saving', () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')!;

    const result = validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-webdav',
      settings: {
        routePath: 'dav/',
        mounts: VALID_MOUNTS,
      },
    });

    expect(result.success).toBe(true);
    expect(result.settings.routePath).toBe('/dav');
    expect(result.settings.protocolEnabled).toBe('true');
    expect(result.settings.failBanEnabled).toBe('true');
    expect(result.settings.failBanMaxFailures).toBe(5);
    expect(result.settings.mounts[0]).toMatchObject({
      mount: 'media',
      provider: 'r2',
      bindingName: 'BUCKET',
      prefix: 'uploads',
    });
  });

  it('preserves disabled protocol setting during config validation', () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')!;

    const result = validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-webdav',
      settings: {
        routePath: '/webdav',
        protocolEnabled: 'false',
        mounts: VALID_MOUNTS,
      },
    });

    expect(result.success).toBe(true);
    expect(result.settings.protocolEnabled).toBe('false');
  });

  it('ignores requests outside the configured route', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/not-dav'),
      path: '/not-dav',
      options: {
        'plugin:typecho-plugin-webdav': JSON.stringify({
          routePath: '/dav',
          mounts: VALID_MOUNTS,
        }),
      },
    });

    expect(result).toEqual({ handled: false });
  });

  it('responds to WebDAV OPTIONS without requiring Basic Auth', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/dav', { method: 'OPTIONS' }),
      path: '/dav',
      options: {
        'plugin:typecho-plugin-webdav': JSON.stringify({
          routePath: '/dav',
          mounts: VALID_MOUNTS,
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(204);
    expect(result.response.headers.get('DAV')).toBe('1, 2');
    expect(result.response.headers.get('Allow')).toContain('PROPFIND');
  });

  it('does not claim the WebDAV route when the protocol entry is disabled', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/webdav', { method: 'OPTIONS' }),
      path: '/webdav',
      options: {
        'plugin:typecho-plugin-webdav': JSON.stringify({
          protocolEnabled: false,
          routePath: '/webdav',
          mounts: VALID_MOUNTS,
        }),
      },
    });

    expect(result).toEqual({ handled: false });
  });

  it('allows administrators to PROPFIND the default /webdav root route', async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put('cc-switch-sync/', '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });

    const result = await routeWithAuth(new Request('https://example.com/webdav', {
      method: 'PROPFIND',
      headers: {
        authorization: basicAuth(),
        depth: '1',
      },
    }), {}, { BUCKET: bucket }, 'administrator', 'admin');
    const xml = await result.response.text();

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(207);
    expect(xml).toContain('<d:href>/webdav/</d:href>');
    expect(xml).toContain('<d:href>/webdav/cc-switch-sync/</d:href>');
  });

  it('shows a browser directory page for GET on the default /webdav root route', async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put('cc-switch-sync/', '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });
    await bucket.put('cc-switch-sync/readme.txt', 'hello', {
      httpMetadata: { contentType: 'text/plain' },
    });

    const result = await routeWithAuth(new Request('https://example.com/webdav', {
      method: 'GET',
      headers: { authorization: basicAuth() },
    }), {}, { BUCKET: bucket }, 'administrator', 'admin');
    const html = await result.response.text();

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('Content-Type')).toContain('text/html');
    expect(html).toContain('cc-switch-sync/');
    expect(html).toContain('/webdav/cc-switch-sync/');

    const child = await routeWithAuth(new Request('https://example.com/webdav/cc-switch-sync', {
      method: 'GET',
      headers: { authorization: basicAuth() },
    }), {}, { BUCKET: bucket }, 'administrator', 'admin');
    const childHtml = await child.response.text();

    expect(child.response.status).toBe(200);
    expect(childHtml).toContain('readme.txt');
  });

  it('keeps /webdav working when an old default /dav route is saved', async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put('cc-switch-sync/', '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });

    const result = await routeWithAuth(new Request('https://example.com/webdav', {
      method: 'GET',
      headers: { authorization: basicAuth() },
    }), {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: '',
        },
      ],
    }, { BUCKET: bucket }, 'administrator', 'admin');
    const html = await result.response.text();

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    expect(html).toContain('/webdav/cc-switch-sync/');
  });

  it('creates a directory at a root-mounted R2 bucket and exposes it as a WebDAV collection', async () => {
    const bucket = new MemoryR2Bucket();
    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: '',
        },
      ],
    };

    const mkcol = await routeWithAuth(new Request('https://example.com/dav/photos', {
      method: 'MKCOL',
      headers: { authorization: basicAuth() },
    }), settings, { BUCKET: bucket });

    expect(mkcol.handled).toBe(true);
    expect(mkcol.response.status).toBe(201);
    expect(bucket.objects.has('photos/')).toBe(true);

    const propfind = await routeWithAuth(new Request('https://example.com/dav/photos', {
      method: 'PROPFIND',
      headers: {
        authorization: basicAuth(),
        depth: '0',
      },
    }), settings, { BUCKET: bucket });
    const xml = await propfind.response.text();

    expect(propfind.response.status).toBe(207);
    expect(xml).toContain('<d:href>/dav/photos/</d:href>');
    expect(xml).toContain('<d:resourcetype><d:collection /></d:resourcetype>');
  });

  it('rejects authenticated non-admin users with a Basic Auth challenge', async () => {
    const bucket = new MemoryR2Bucket();
    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: '',
        },
      ],
    };

    const result = await routeWithAuth(new Request('https://example.com/dav/cc-switch-sync/', {
      method: 'MKCOL',
      headers: { authorization: basicAuth('alice') },
    }), settings, { BUCKET: bucket }, 'subscriber', 'alice');

    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('WWW-Authenticate')).toContain('Basic realm="Typecho WebDAV"');
    expect(bucket.objects.has('cc-switch-sync/')).toBe(false);
  });

  it('does not return 403 for non-admin PROPFIND attempts', async () => {
    const bucket = new MemoryR2Bucket();
    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: '',
        },
      ],
    };

    const result = await routeWithAuth(new Request('https://example.com/dav', {
      method: 'PROPFIND',
      headers: {
        authorization: basicAuth('alice'),
        depth: '1',
      },
    }), settings, { BUCKET: bucket }, 'subscriber', 'alice');

    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('WWW-Authenticate')).toContain('Basic realm="Typecho WebDAV"');
  });

  it('allows administrators to access every mount', async () => {
    const bucket = new MemoryR2Bucket();
    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: '',
        },
      ],
    };

    const result = await routeWithAuth(new Request('https://example.com/dav/admin-only/', {
      method: 'MKCOL',
      headers: { authorization: basicAuth() },
    }), settings, { BUCKET: bucket }, 'administrator', 'admin');

    expect(result.response.status).toBe(201);
    expect(bucket.objects.has('admin-only/')).toBe(true);
  });

  it('lists every mount for administrators at the WebDAV root', async () => {
    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: 'media',
          provider: 'r2',
          bindingName: 'MEDIA_BUCKET',
          prefix: '',
        },
        {
          mount: 'backup',
          provider: 'r2',
          bindingName: 'BACKUP_BUCKET',
          prefix: '',
        },
      ],
    };

    const result = await routeWithAuth(new Request('https://example.com/dav', {
      method: 'PROPFIND',
      headers: {
        authorization: basicAuth('admin'),
        depth: '1',
      },
    }), settings, {}, 'administrator', 'admin');
    const xml = await result.response.text();

    expect(result.response.status).toBe(207);
    expect(xml).toContain('<d:href>/dav/media/</d:href>');
    expect(xml).toContain('<d:href>/dav/backup/</d:href>');
  });

  it('creates directories under the configured bucket prefix', async () => {
    const bucket = new MemoryR2Bucket();
    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: 'uploads',
        },
      ],
    };

    const result = await routeWithAuth(new Request('https://example.com/dav/albums', {
      method: 'MKCOL',
      headers: { authorization: basicAuth() },
    }), settings, { BUCKET: bucket }, 'administrator', 'admin');

    expect(result.response.status).toBe(201);
    expect(bucket.objects.has('uploads/albums/')).toBe(true);
  });

  it('lists directory children with PROPFIND depth 1 without requiring a trailing slash', async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put('photos/', '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });
    await bucket.put('photos/readme.txt', 'hello', {
      httpMetadata: { contentType: 'text/plain' },
    });
    await bucket.put('photos/nested/', '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });

    const settings = {
      routePath: '/dav',
      mounts: [
        {
          mount: '',
          provider: 'r2',
          bindingName: 'BUCKET',
          prefix: '',
        },
      ],
    };

    const propfind = await routeWithAuth(new Request('https://example.com/dav/photos', {
      method: 'PROPFIND',
      headers: {
        authorization: basicAuth(),
        depth: '1',
      },
    }), settings, { BUCKET: bucket }, 'administrator', 'admin');
    const xml = await propfind.response.text();

    expect(propfind.response.status).toBe(207);
    expect(xml).toContain('<d:href>/dav/photos/</d:href>');
    expect(xml).toContain('<d:href>/dav/photos/readme.txt</d:href>');
    expect(xml).toContain('<d:href>/dav/photos/nested/</d:href>');
    expect(xml.match(/<d:resourcetype><d:collection \/><\/d:resourcetype>/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('typecho-plugin-webdav admin panel', () => {
  it('does not intercept /admin/webdav (served by admin:page framework)', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/admin/webdav'),
      path: '/admin/webdav',
      db: { query: { users: { findFirst: async () => null } } },
      options: {},
    });

    // Plugin no longer intercepts /admin/webdav; Astro renders via admin:page hook
    expect(result.handled).toBe(false);
  });

  it('returns 401 JSON for unauthenticated /api/admin/webdav', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/api/admin/webdav?action=list'),
      path: '/api/admin/webdav',
      db: { query: { users: { findFirst: async () => null } } },
      options: {},
    });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('Content-Type')).toContain('application/json');
  });

  it('lists named mounts at the admin API root', async () => {
    const bucket = new MemoryR2Bucket();
    const result = await routeAdminApiWithAuth('/api/admin/webdav?action=list&path=', {
      routePath: '/webdav',
      mounts: [
        { mount: 'media', provider: 'r2', bindingName: 'BUCKET' },
        { mount: 'backup', provider: 'r2', bindingName: 'BUCKET' },
      ],
    }, { BUCKET: bucket });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.success).toBe(true);
    expect(body.data.prefixes).toEqual(['media/', 'backup/']);
    expect(body.data.objects).toEqual([]);
  });

  it('rejects cross-origin POST on admin API', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;
    const secret = 'admin-secret';
    const authCode = 'admin-auth';
    const token = await generateAuthToken(1, authCode, secret);
    const csrf = await generateSecurityToken(secret, authCode, 1);

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/api/admin/webdav', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          Origin: 'https://evil.example',
          cookie: `__typecho_uid=1; __typecho_authCode=${token.split(':')[1]}`,
        },
        body: JSON.stringify({ action: 'mkdir', path: 'x' }),
      }),
      path: '/api/admin/webdav',
      db: {
        query: {
          users: {
            findFirst: async () => ({
              uid: 1,
              name: 'admin',
              authCode,
              group: 'administrator',
            }),
          },
        },
      },
      options: {
        secret,
        siteUrl: 'https://example.com',
        'plugin:typecho-plugin-webdav': JSON.stringify({
          routePath: '/webdav',
          mounts: [{ mount: 'media', provider: 'r2', bindingName: 'BUCKET' }],
        }),
      },
      env: { BUCKET: new MemoryR2Bucket() },
    });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(403);
  });

  it('rejects oversized JSON bodies on admin API', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;
    const secret = 'admin-secret';
    const authCode = 'admin-auth';
    const token = await generateAuthToken(1, authCode, secret);
    const csrf = await generateSecurityToken(secret, authCode, 1);
    const oversized = 'x'.repeat(REQUEST_BODY_LIMITS.adminForm + 1);

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/api/admin/webdav', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          Origin: 'https://example.com',
          cookie: `__typecho_uid=1; __typecho_authCode=${token.split(':')[1]}`,
        },
        body: JSON.stringify({ action: 'mkdir', path: oversized }),
      }),
      path: '/api/admin/webdav',
      db: {
        query: {
          users: {
            findFirst: async () => ({
              uid: 1,
              name: 'admin',
              authCode,
              group: 'administrator',
            }),
          },
        },
      },
      options: {
        secret,
        siteUrl: 'https://example.com',
        'plugin:typecho-plugin-webdav': JSON.stringify({
          routePath: '/webdav',
          mounts: [{ mount: 'media', provider: 'r2', bindingName: 'BUCKET' }],
        }),
      },
      env: { BUCKET: new MemoryR2Bucket() },
    });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(413);
  });

  it('injects WebDav menu item for administrators via admin:footer', () => {
    const hooks = collectHooks();
    const footer = hooks.get('admin:footer')!;

    const result = footer('', { activeMenu: 'manage-posts', user: { group: 'administrator' } });
    expect(result).toContain('WebDAV');
    expect(result).toContain('/admin/plugin/webdav');
    expect(result).toContain('<script>');
  });

  it('renders syntactically valid admin page scripts', () => {
    const hooks = collectHooks();
    const page = hooks.get('admin:page')!;

    const result = page('', { slug: 'webdav', csrfToken: 'csrf-token' });
    const scripts = [...result.matchAll(/<script>\s*([\s\S]*?)\s*<\/script>/g)].map(match => match[1]);

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('does not inject menu item for non-admin users', () => {
    const hooks = collectHooks();
    const footer = hooks.get('admin:footer')!;

    const result = footer('existing-content', { activeMenu: 'manage-posts', user: { group: 'editor' } });
    expect(result).toBe('existing-content');
    expect(result).not.toContain('WebDAV');
  });

  it('adds focus class when webdav menu is active', () => {
    const hooks = collectHooks();
    const footer = hooks.get('admin:footer')!;

    const result = footer('', { activeMenu: 'webdav', user: { group: 'administrator' } });
    expect(result).toContain("className = 'focus'");
  });

  it('does not treat /admin/webdav as WebDAV protocol path', async () => {
    const hooks = collectHooks();
    const route = hooks.get('route:request')!;

    const result = await route({ handled: false }, {
      request: new Request('https://example.com/admin/webdav'),
      path: '/admin/webdav',
      db: { query: { users: { findFirst: async () => null } } },
      options: {
        'plugin:typecho-plugin-webdav': JSON.stringify({ routePath: '/webdav', mounts: VALID_MOUNTS }),
      },
    });

    // Plugin does not intercept /admin/webdav (admin:page framework handles it).
    // Also must NOT be caught by WebDAV protocol (routePath is /webdav, not /admin/webdav)
    expect(result.handled).toBe(false);
  });
});
