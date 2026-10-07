import { afterEach, describe, expect, it, vi } from 'vitest';
import init, {
  canRenderSyncTitleAction,
  extractImageUrls,
  MAX_WECHAT_BODY_IMAGES,
  MAX_WECHAT_IMAGE_BYTES,
  MAX_WECHAT_SYNC_IMAGE_BYTES,
  normalizeConfig,
  renderWeChatHtml,
} from './index';
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
    registerRouteResolver: () => {},
    registerAdminPath: () => {},
    registerTranslations: () => {},
    registerScheduledTask: () => {},
    registerAsyncTask: () => {},
    enqueueAsyncTask: async () => ({
      jobId: 'test-job',
      taskKey: 'test-task',
      idempotencyKey: 'test-key',
    }),
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
      'plugin:typecho-plugin-wechat-publisher:action:authorize',
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

  it('hides the sync button for posts without images and without defaultCoverUrl', () => {
    const hooks = collectHooks();
    const render = hooks.get('admin:managePosts:titleActions')![0];

    expect(render('<span>existing</span>', { post: { cid: 42, type: 'post', text: '<!--markdown-->纯文本正文' } })).toBe('<span>existing</span>');
    expect(render('', { post: { cid: 42, type: 'page', text: '<!--markdown-->![图](/usr/uploads/a.jpg)' } })).toBe('');
    expect(canRenderSyncTitleAction({ cid: 42, type: 'post', text: '<p><img src="/usr/uploads/a.jpg" /></p>' })).toBe(true);
  });

  it('shows the sync button for posts without body images when defaultCoverUrl is configured', () => {
    const hooks = collectHooks();
    const render = hooks.get('admin:managePosts:titleActions')![0];
    const optionsWithCover = {
      'plugin:typecho-plugin-wechat-publisher': JSON.stringify({
        appId: 'appid',
        appSecret: 'secret',
        defaultCoverUrl: 'https://example.com/default-cover.jpg',
      }),
    };

    const html = render('', { post: { cid: 42, type: 'post', text: '<!--markdown-->纯文本正文，无图片' }, options: optionsWithCover });
    expect(html).toContain('typecho-wechat-sync');
    expect(html).toContain('data-cid="42"');

    expect(canRenderSyncTitleAction({ cid: 42, type: 'post', text: '纯文本' }, optionsWithCover)).toBe(true);
    expect(canRenderSyncTitleAction({ cid: 42, type: 'post', text: '纯文本' })).toBe(false);
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
    expect(inserted.filter(row => row.name !== 'cacheVersion').map(row => row.name)).toEqual([
      'plugin:typecho-plugin-wechat-publisher:post:7',
    ]);
  });

  it('coalesces concurrent synchronization requests for one cid across fresh request database handles', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db } = mockDb();
    const { db: secondRequestDb } = mockDb();
    let draftCreates = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'token-dedupe' });
      if (target.includes('/usr/uploads/a.jpg')) return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
      if (target.includes('/cgi-bin/media/uploadimg')) return Response.json({ url: 'https://mmbiz.qpic.cn/dedupe.jpg' });
      if (target.includes('/cgi-bin/material/add_material')) return Response.json({ media_id: 'cover-dedupe' });
      if (target.includes('/cgi-bin/draft/add')) {
        draftCreates += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return Response.json({ media_id: 'draft-dedupe' });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const extra = {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor', screenName: '当前用户' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({ appId: 'appid-dedupe', appSecret: 'secret' }),
      },
    };

    const [first, second] = await Promise.all([
      action({ handled: false }, extra),
      action({ handled: false }, { ...extra, db: secondRequestDb }),
    ]);

    expect(first).toMatchObject({ success: true, mediaId: 'draft-dedupe' });
    expect(second).toEqual(first);
    expect(draftCreates).toBe(1);
    expect(db.query.contents.findFirst).toHaveBeenCalledTimes(1);
    expect(secondRequestDb.query.contents.findFirst).not.toHaveBeenCalled();
  });

  it('rejects body image counts above the documented limit before contacting WeChat', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const imageMarkdown = Array.from({ length: MAX_WECHAT_BODY_IMAGES + 1 }, (_, index) => `![${index}](https://img.example/${index}.jpg)`).join('\n\n');
    const { db } = mockDb(null, [], `<!--markdown-->${imageMarkdown}`);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({ appId: 'appid-image-limit', appSecret: 'secret' }),
      },
    });

    expect(result).toMatchObject({ handled: true, success: false });
    expect((result as any).error).toContain(String(MAX_WECHAT_BODY_IMAGES));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a streamed image body that exceeds the per-image byte limit', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const { db } = mockDb(null, [], '<!--markdown-->![图](https://img.example/oversized.jpg)');
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'token-too-large' });
      if (target === 'https://img.example/oversized.jpg') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_WECHAT_IMAGE_BYTES + 1));
            controller.close();
          },
        }), { headers: { 'Content-Type': 'image/jpeg' } });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({ appId: 'appid-image-byte-limit', appSecret: 'secret' }),
      },
    });

    expect(result).toMatchObject({ handled: true, success: false });
    expect((result as any).error).toContain('10 MiB');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cgi-bin/media/uploadimg'))).toBe(false);
  });

  it('enforces a shared byte budget across body images', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const imageMarkdown = Array.from({ length: 4 }, (_, index) => `![${index}](https://img.example/large-${index}.jpg)`).join('\n\n');
    const { db } = mockDb(null, [], `<!--markdown-->${imageMarkdown}`);
    const imageBytes = 8 * 1024 * 1024;
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'token-total-byte-limit' });
      if (target.startsWith('https://img.example/')) {
        return new Response(new Uint8Array(imageBytes), {
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(imageBytes) },
        });
      }
      if (target.includes('/cgi-bin/media/uploadimg')) return Response.json({ url: 'https://mmbiz.qpic.cn/large.jpg' });
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({ appId: 'appid-total-byte-limit', appSecret: 'secret' }),
      },
    });

    expect(result).toMatchObject({ handled: true, success: false });
    expect((result as any).error).toContain('30 MiB');
    expect(MAX_WECHAT_SYNC_IMAGE_BYTES).toBe(30 * 1024 * 1024);
  });

  it('limits concurrent body image uploads to three', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-wechat-publisher:action')![0];
    const imageMarkdown = Array.from({ length: 4 }, (_, index) => `![${index}](https://img.example/${index}.jpg)`).join('\n\n');
    const { db } = mockDb(null, [], `<!--markdown-->${imageMarkdown}`);
    let activeUploads = 0;
    let peakUploads = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'token-concurrency' });
      if (target.startsWith('https://img.example/')) return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
      if (target.includes('/cgi-bin/media/uploadimg')) {
        activeUploads += 1;
        peakUploads = Math.max(peakUploads, activeUploads);
        await new Promise(resolve => setTimeout(resolve, 0));
        activeUploads -= 1;
        return Response.json({ url: `https://mmbiz.qpic.cn/body-${peakUploads}.jpg` });
      }
      if (target.includes('/cgi-bin/material/add_material')) return Response.json({ media_id: 'cover-concurrency' });
      if (target.includes('/cgi-bin/draft/add')) return Response.json({ media_id: 'draft-concurrency' });
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await action({ handled: false }, {
      action: 'sync',
      payload: { cid: 7 },
      db,
      user: { uid: 3, group: 'contributor' },
      options: {
        siteUrl: 'https://blog.example',
        'plugin:typecho-plugin-wechat-publisher': JSON.stringify({ appId: 'appid-image-concurrency', appSecret: 'secret' }),
      },
    });

    expect(result).toMatchObject({ success: true, uploadedImages: 4 });
    expect(peakUploads).toBe(3);
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
    expect(inserted.filter(row => row.name !== 'cacheVersion').map(row => row.name)).toEqual([
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
    expect(inserted.filter(row => row.name !== 'cacheVersion').map(row => row.name)).toEqual([
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
