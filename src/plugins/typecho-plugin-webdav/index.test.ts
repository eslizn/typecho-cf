import { describe, expect, it } from 'vitest';
import { hashPassword } from '@/lib/auth';
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

function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-webdav',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
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
      mounts: VALID_MOUNTS,
      failBanEnabled: 'true',
      failBanMaxFailures: '3',
      failBanWindowSeconds: '120',
      failBanSeconds: '600',
    });

    expect(config.routePath).toBe('/webdav');
    expect(config.mounts[0].bindingName).toBe('BUCKET');
    expect(config.failBanEnabled).toBe(true);
    expect(config.failBanMaxFailures).toBe(3);
    expect(config.failBanWindowSeconds).toBe(120);
    expect(config.failBanSeconds).toBe(600);
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

describe('typecho-plugin-webdav hooks', () => {
  it('registers config validation and route hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'plugin:config:beforeSave',
      'route:request',
    ]);
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
    expect(result.settings.failBanMaxFailures).toBe(5);
    expect(result.settings.mounts[0]).toMatchObject({
      mount: 'media',
      provider: 'r2',
      bindingName: 'BUCKET',
      prefix: 'uploads',
    });
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
