import { describe, expect, it } from 'vitest';
import init, {
  matchWebDavRoute,
  normalizeConfig,
  normalizeRoutePath,
  parseBasicCredentials,
  parseMounts,
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

describe('typecho-plugin-webdav config', () => {
  it('normalizes the WebDAV route path', () => {
    expect(normalizeRoutePath('dav/')).toBe('/dav');
    expect(normalizeRoutePath('/storage/dav/')).toBe('/storage/dav');
    expect(normalizeRoutePath('/')).toBe('/dav');
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
    expect(mounts[0]).toMatchObject({ mount: 'media', provider: 'r2', bindingName: 'BUCKET', prefix: 'uploads' });
    expect(mounts[1]).toMatchObject({ mount: 'backup', provider: 's3', pathStyle: false });
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
      requiredGroup: 'administrator',
      mounts: VALID_MOUNTS,
    });

    expect(config.routePath).toBe('/webdav');
    expect(config.requiredGroup).toBe('administrator');
    expect(config.mounts[0].bindingName).toBe('BUCKET');
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
        requiredGroup: 'editor',
        mounts: VALID_MOUNTS,
      },
    });

    expect(result.success).toBe(true);
    expect(result.settings.routePath).toBe('/dav');
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
          requiredGroup: 'editor',
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
          requiredGroup: 'editor',
          mounts: VALID_MOUNTS,
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(204);
    expect(result.response.headers.get('DAV')).toBe('1, 2');
    expect(result.response.headers.get('Allow')).toContain('PROPFIND');
  });
});
