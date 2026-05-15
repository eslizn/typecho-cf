import { afterEach, describe, expect, it, vi } from 'vitest';
import init, { canRenderSyncTitleAction, extractImageUrls, normalizeConfig, renderWeChatHtml } from './index';
import { env } from 'cloudflare:workers';

function collectHooks() {
  const hooks = new Map<string, Function[]>();
  init({
    pluginId: 'typecho-plugin-wechat-publisher',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      const list = hooks.get(point) || [];
      list.push(handler);
      hooks.set(point, list);
    },
  });
  return hooks;
}

function mockDb(syncState?: Record<string, unknown> | null, attachments: any[] = [], postText?: string) {
  const inserted: any[] = [];
  const chain = {
    values(value: any) {
      inserted.push(value);
      return this;
    },
    async onConflictDoUpdate() {
      return undefined;
    },
  };

  return {
    inserted,
    db: {
      query: {
        contents: {
          findFirst: vi.fn(async () => ({
            cid: 7,
            title: '同步测试',
            slug: 'sync-test',
            type: 'post',
            text: postText ?? '<!--markdown-->正文\n\n![图](/usr/uploads/a.jpg)',
            created: 1_700_000_000,
            authorId: 3,
          })),
          findMany: vi.fn(async () => attachments),
        },
        users: {
          findFirst: vi.fn(async () => ({ screenName: '作者名', name: 'author' })),
        },
        options: {
          findFirst: vi.fn(async () => syncState
            ? { name: 'plugin:typecho-plugin-wechat-publisher:post:7', value: JSON.stringify(syncState) }
            : null),
        },
        fields: {
          findFirst: vi.fn(async () => null),
        },
      },
      insert: vi.fn(() => chain),
    },
  };
}

describe('typecho-plugin-wechat-publisher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    env.BUCKET = null as any;
  });

  it('registers admin title, footer, config, and action hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'admin:footer',
      'admin:managePosts:titleActions',
      'plugin:config:beforeSave',
      'plugin:typecho-plugin-wechat-publisher:action',
    ]);
  });

  it('injects a compact sync button in the post title actions', () => {
    const hooks = collectHooks();
    const render = hooks.get('admin:managePosts:titleActions')![0];

    const html = render('', { post: { cid: 42, type: 'post', text: '<!--markdown-->正文\n\n![图](/usr/uploads/a.jpg)' } });

    expect(html).toContain('typecho-wechat-sync');
    expect(html).toContain('data-cid="42"');
    expect(html).toContain('aria-label="同步到微信公众号草稿"');
    expect(html).toContain('typecho-wechat-sync-icon');
    expect(html).toContain('<svg');
  });

  it('does not inject the post title sync button for posts without body images', () => {
    const hooks = collectHooks();
    const render = hooks.get('admin:managePosts:titleActions')![0];

    expect(render('<span>existing</span>', { post: { cid: 42, type: 'post', text: '<!--markdown-->纯文本正文' } })).toBe('<span>existing</span>');
    expect(render('', { post: { cid: 42, type: 'page', text: '<!--markdown-->![图](/usr/uploads/a.jpg)' } })).toBe('');
    expect(canRenderSyncTitleAction({ cid: 42, type: 'post', text: '<p><img src="/usr/uploads/a.jpg" /></p>' })).toBe(true);
  });

  it('injects admin JavaScript only on the post list page', () => {
    const hooks = collectHooks();
    const footer = hooks.get('admin:footer')![0];

    expect(footer('', { activeMenu: 'manage-posts' })).toContain('/api/admin/plugin-action');
    expect(footer('', { activeMenu: 'plugins' })).toBe('');
  });

  it('validates required WeChat credentials', () => {
    expect(() => normalizeConfig({ appId: '', appSecret: '' })).toThrow('请填写微信公众号 AppID 和 AppSecret');
    expect(normalizeConfig({ appId: 'appid', appSecret: 'secret' })).toMatchObject({
      appId: 'appid',
      appSecret: 'secret',
      sourceUrlMode: 'permalink',
    });
  });

  it('renders markdown to sanitized WeChat HTML and extracts images', () => {
    const html = renderWeChatHtml('<!--markdown--># 标题\n\n正文\n\n![图](/a.png)<script>alert(1)</script>');

    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<img src="/a.png" alt="图"');
    expect(html).not.toContain('<script>');
    expect(extractImageUrls(html)).toEqual(['/a.png']);
  });

  it('syncs a post by uploading body image, cover image, and creating a draft', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db, inserted } = mockDb();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) {
        return new Response(JSON.stringify({ access_token: 'token' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://blog.example/usr/uploads/a.jpg') {
        return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ url: 'https://mmbiz.qpic.cn/body.jpg' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/material/add_material')) {
        expect(target).toContain('type=image');
        return new Response(JSON.stringify({ media_id: 'cover-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/add')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.articles[0]).toMatchObject({
          title: '同步测试',
          thumb_media_id: 'cover-media-id',
          content_source_url: 'https://blog.example/archives/7/',
        });
        expect(body.articles[0].content).toContain('https://mmbiz.qpic.cn/body.jpg');
        return new Response(JSON.stringify({ media_id: 'draft-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
          appId: 'appid',
          appSecret: 'secret',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: true,
      mediaId: 'draft-media-id',
      mode: 'created',
      uploadedImages: 1,
    });
    expect(inserted.map(row => row.name)).toEqual([
      'plugin:typecho-plugin-wechat-publisher:post:7',
    ]);
  });

  it('reads local upload images from R2 instead of refetching the public site URL', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db, inserted } = mockDb();
    const bucketGet = vi.fn(async (key: string) => ({
      body: new Blob(['r2-image'], { type: 'image/jpeg' }).stream(),
      httpEtag: '"etag"',
      httpMetadata: { contentType: 'image/jpeg' },
      key,
    }));
    env.BUCKET = { get: bucketGet } as any;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) {
        return new Response(JSON.stringify({ access_token: 'token-r2' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://blog.example/usr/uploads/a.jpg') {
        return new Response('timeout', { status: 522 });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) {
        return new Response(JSON.stringify({ url: 'https://mmbiz.qpic.cn/body-r2.jpg' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/material/add_material')) {
        return new Response(JSON.stringify({ media_id: 'cover-r2-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/add')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.articles[0].content).toContain('https://mmbiz.qpic.cn/body-r2.jpg');
        return new Response(JSON.stringify({ media_id: 'draft-r2-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
          appId: 'appid-r2',
          appSecret: 'secret',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: true,
      mediaId: 'draft-r2-media-id',
      mode: 'created',
      uploadedImages: 1,
    });
    expect(bucketGet).toHaveBeenCalledWith('usr/uploads/a.jpg');
    expect(fetchMock).not.toHaveBeenCalledWith('https://blog.example/usr/uploads/a.jpg', expect.anything());
    expect(inserted.map(row => row.name)).toEqual([
      'plugin:typecho-plugin-wechat-publisher:post:7',
    ]);
  });

  it('reads absolute upload URLs from R2 even when the origin differs from siteUrl', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db } = mockDb(null, [], '<!--markdown-->正文\n\n![图](https://cdn.example/usr/uploads/a.jpg)');
    const bucketGet = vi.fn(async (key: string) => ({
      body: new Blob(['r2-image'], { type: 'image/jpeg' }).stream(),
      httpEtag: '"etag"',
      httpMetadata: { contentType: 'image/jpeg' },
      key,
    }));
    env.BUCKET = { get: bucketGet } as any;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) {
        return new Response(JSON.stringify({ access_token: 'token-r2-origin' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://cdn.example/usr/uploads/a.jpg') {
        return new Response('timeout', { status: 522 });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) {
        return new Response(JSON.stringify({ url: 'https://mmbiz.qpic.cn/body-origin.jpg' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/material/add_material')) {
        return new Response(JSON.stringify({ media_id: 'cover-origin-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/add')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.articles[0].content).toContain('https://mmbiz.qpic.cn/body-origin.jpg');
        return new Response(JSON.stringify({ media_id: 'draft-origin-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
          appId: 'appid-r2-origin',
          appSecret: 'secret',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: true,
      mediaId: 'draft-origin-media-id',
    });
    expect(bucketGet).toHaveBeenCalledWith('usr/uploads/a.jpg');
    expect(fetchMock).not.toHaveBeenCalledWith('https://cdn.example/usr/uploads/a.jpg', expect.anything());
  });

  it('updates the existing WeChat draft when a sync state media id exists', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db, inserted } = mockDb({ mediaId: 'existing-draft-media-id', updatedAt: 1_700_000_000 });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) {
        return new Response(JSON.stringify({ access_token: 'token-update' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://blog.example/usr/uploads/a.jpg') {
        return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) {
        return new Response(JSON.stringify({ url: 'https://mmbiz.qpic.cn/body-update.jpg' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/material/add_material')) {
        return new Response(JSON.stringify({ media_id: 'cover-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/update')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body).toMatchObject({
          media_id: 'existing-draft-media-id',
          index: 0,
        });
        expect(body.articles.title).toBe('同步测试');
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/add')) {
        throw new Error('should update instead of creating a new draft');
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
          appId: 'appid-update',
          appSecret: 'secret',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: true,
      mediaId: 'existing-draft-media-id',
      mode: 'updated',
    });
    expect(inserted.map(row => row.name)).toEqual([
      'plugin:typecho-plugin-wechat-publisher:post:7',
    ]);
  });

  it('creates a new draft and refreshes state when the saved media id is stale', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db, inserted } = mockDb({ mediaId: 'stale-draft-media-id', updatedAt: 1_700_000_000 });
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) {
        return new Response(JSON.stringify({ access_token: 'token-stale' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://blog.example/usr/uploads/a.jpg') {
        return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) {
        return new Response(JSON.stringify({ url: 'https://mmbiz.qpic.cn/body-stale.jpg' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/material/add_material')) {
        return new Response(JSON.stringify({ media_id: 'cover-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/update')) {
        return new Response(JSON.stringify({ errcode: 40007, errmsg: 'invalid media_id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/add')) {
        return new Response(JSON.stringify({ media_id: 'new-draft-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
          appId: 'appid-stale',
          appSecret: 'secret',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: true,
      mediaId: 'new-draft-media-id',
      mode: 'created',
    });
    const saved = JSON.parse(inserted[0].value);
    expect(saved.mediaId).toBe('new-draft-media-id');
  });

  it('uses attachment cover image when post body has no images', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    // Post without inline images — cover must come from attachment
    const postText = '<!--markdown-->纯文本文章，无图片';
    const attachments = [
      { cid: 8, text: JSON.stringify({ url: '/usr/uploads/cover.jpg', name: 'cover.jpg', type: 'image/jpeg', size: 51200 }) },
    ];
    const { db, inserted } = mockDb(null, attachments, postText);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) {
        return new Response(JSON.stringify({ access_token: 'token' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://blog.example/usr/uploads/cover.jpg') {
        return new Response(new Blob(['cover-image-data'], { type: 'image/jpeg' }), {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) {
        throw new Error('should not upload body images when none exist');
      }
      if (target.includes('/cgi-bin/material/add_material')) {
        expect(target).toContain('type=image');
        return new Response(JSON.stringify({ media_id: 'attachment-cover-media-id' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/cgi-bin/draft/add')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.articles[0].thumb_media_id).toBe('attachment-cover-media-id');
        return new Response(JSON.stringify({ media_id: 'draft-from-attachment' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
          appId: 'appid',
          appSecret: 'secret',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: true,
      mediaId: 'draft-from-attachment',
      mode: 'created',
      uploadedImages: 0,
    });
  });
});
