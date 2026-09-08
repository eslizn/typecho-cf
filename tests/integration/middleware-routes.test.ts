/**
 * Middleware redirect-loop smoke tests.
 *
 * Sends real GET requests through the middleware to verify that no path
 * produces a 302 redirect when the DB is seeded and ready.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { resetIsolateBoot } from '@/lib/isolate-boot';

let testDb: TestDatabase;

// We need env.DB to be a real-enough D1 stub so ensureTablesReady doesn't throw.
// The test DB is a @libsql/client SQLite file — we don't need the D1 stub for
// anything except middleware's table-existence check.
function createD1Stub(_db: TestDatabase) {
  const stmt = {
    first: (sql?: string) => Promise.resolve(
      typeof sql === 'string' && sql.includes('runtimeSchemaVersion')
        ? { value: '20260816' }
        : { name: 'typecho_options' } as any,
    ),
    all: () => Promise.resolve({
      results: [
        { name: 'email' },
        { name: 'lastSentAt' },
        { name: 'uid' },
        { name: 'tokenHash' },
        { name: 'expiresAt' },
      ],
    }),
    run: () => Promise.resolve({}),
    bind() { return this; },
  };
  return {
    prepare: (sql: string) => ({
      ...stmt,
      first: () => Promise.resolve(
        sql.includes('runtimeSchemaVersion')
          ? { value: '20260816' }
          : { name: 'typecho_options' } as any,
      ),
      bind() { return this; },
      run: () => Promise.resolve({}),
    }),
    batch: (_stmts: any[]) => Promise.resolve([]),
    dump: () => Promise.resolve([]),
    exec: () => Promise.resolve({}),
  };
}

let d1Stub: ReturnType<typeof createD1Stub>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() { return d1Stub; },
    BUCKET: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() },
  },
  caches: { default: { match: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import { schema } from '@/db';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { onRequest } from '@/middleware';
import { addHook, registerPluginRoute } from '@/lib/plugin';

const SITE = 'http://localhost:4321';

interface TestCase {
  method: string;
  path: string;
  expectStatus: number;
}

const routes: TestCase[] = [
  // Static/bypass paths
  { method: 'GET', path: '/install', expectStatus: 200 },
  { method: 'GET', path: '/api/install', expectStatus: 200 },
  { method: 'GET', path: '/css/admin.css', expectStatus: 200 },
  { method: 'GET', path: '/vendor/jquery.js', expectStatus: 200 },
  { method: 'GET', path: '/js/test.js', expectStatus: 200 },
  { method: 'GET', path: '/plugin-assets/x/y.js', expectStatus: 200 },
  { method: 'GET', path: '/usr/uploads/2026/07/image.jpg', expectStatus: 200 },

  // Public pages
  { method: 'GET', path: '/', expectStatus: 200 },
  { method: 'GET', path: '/admin/login', expectStatus: 200 },
  { method: 'GET', path: '/admin/forgot-password', expectStatus: 200 },
  { method: 'GET', path: '/admin/reset-password', expectStatus: 200 },
  { method: 'GET', path: '/sitemap.xml', expectStatus: 200 },
  { method: 'GET', path: '/robots.txt', expectStatus: 200 },

  // Admin pages (no auth cookie → should still return 200, not 302 loop)
  { method: 'GET', path: '/admin/', expectStatus: 200 },
  { method: 'GET', path: '/admin/write-post', expectStatus: 200 },
  { method: 'GET', path: '/admin/manage-posts', expectStatus: 200 },

  // Feed routes
  { method: 'GET', path: '/feed/', expectStatus: 200 },
  { method: 'GET', path: '/category/test/feed.xml', expectStatus: 200 },
  { method: 'GET', path: '/tag/test/feed.xml', expectStatus: 200 },
  { method: 'GET', path: '/author/1/feed.xml', expectStatus: 200 },
];

describe('Middleware: no redirect loops when DB is ready', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    d1Stub = createD1Stub(testDb);
    // Seed minimal config so middleware doesn't redirect to /install
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
    await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
    await testDb.insert(schema.options).values({ name: 'secret', user: 0, value: 'test-secret-32-chars-long!!!!!' });
    await testDb.insert(schema.options).values({ name: 'title', user: 0, value: 'Test Blog' });
    await testDb.insert(schema.options).values({ name: 'theme', user: 0, value: 'typecho-theme-minimal' });
  });

  for (const { method, path, expectStatus } of routes) {
    it(`${method} ${path} → ${expectStatus}`, async () => {
      const request = new Request(`${SITE}${path}`, { method });
      const ctx = {
        request,
        url: new URL(`${SITE}${path}`),
        locals: { runtime: undefined },
        redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
        rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      } as any;

      const response = await onRequest(ctx, async () => new Response('ok', { status: 200 })) as Response;
      if (response.status !== expectStatus) {
        const location = response.headers.get('Location') || '(none)';
        throw new Error(`${method} ${path} returned ${response.status} (Location: ${location}), expected ${expectStatus}`);
      }
      expect(response.status).toBe(expectStatus);
    });
  }

  it('schedules edge cache persistence for a cacheable content path', async () => {
    const waitUntil = vi.fn();
    const putSpy = vi.spyOn(caches.default, 'put');
    const request = new Request(`${SITE}/archives/123/`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil } },
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;

    const response = await onRequest(
      ctx,
      async () => new Response('cache me', { status: 200 }),
    ) as Response;

    expect(response.status).toBe(200);
    // loadOptions may also write the options blob into caches.default; assert
    // the page entry itself was scheduled through waitUntil.
    const pagePutIndex = putSpy.mock.calls.findIndex(([req]) => {
      const key = typeof req === 'string'
        ? req
        : req instanceof Request
          ? req.url
          : String(req);
      return key.includes('/archives/123/');
    });
    expect(pagePutIndex).toBeGreaterThanOrEqual(0);
    expect(waitUntil).toHaveBeenCalledWith(putSpy.mock.results[pagePutIndex]?.value);
    putSpy.mockRestore();
  });

  it('never caches the internal permalink rewrite target', async () => {
    // Simulates the second middleware pass after /pages/{slug}/ rewrote to
    // the built-in /archives/{cid}/ route: the internal URL must not become
    // a cache entry (otherwise page content could be served at the post URL,
    // breaking the canonical 302 on a cold cache).
    const waitUntil = vi.fn();
    const putSpy = vi.spyOn(caches.default, 'put');
    const request = new Request(`${SITE}/contents/123/`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil }, _permalinkRewrite: true },
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;

    const response = await onRequest(
      ctx,
      async () => new Response('page content', { status: 200 }),
    ) as Response;

    expect(response.status).toBe(200);
    // loadOptions may still write the options blob; only the /archives/123/
    // page entry must be absent.
    const pagePut = putSpy.mock.calls.find(([req]) => {
      const key = typeof req === 'string' ? req : req instanceof Request ? req.url : String(req);
      return key.includes('/contents/123/');
    });
    expect(pagePut).toBeUndefined();
    putSpy.mockRestore();
  });

  it('rewrites the default bare-slug page form to the unified content entry', async () => {
    await testDb.insert(schema.contents).values({
      cid: 777, title: 'About', slug: 'about-default', type: 'page', status: 'publish',
      authorId: 1, created: Math.floor(Date.now() / 1000),
    });
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = {
      request: new Request(`${SITE}/about-default`, { method: 'GET' }),
      url: new URL(`${SITE}/about-default`),
      locals: { runtime: undefined },
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/777/');
    expect(ctx.locals._permalinkRewrite).toBe(true);
    expect(ctx.locals._permalinkSourcePath).toBe('/about-default');
  });
  it('rewrites the default post URL form to the unified content entry', async () => {
    // /archives/{cid}/ is the default post pattern; it is a URL *form*, not
    // a route, so the middleware routes it to /contents/{cid}/ like any
    // custom pattern URL.
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = {
      request: new Request(`${SITE}/archives/123/`, { method: 'GET' }),
      url: new URL(`${SITE}/archives/123/`),
      locals: { runtime: undefined },
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/123/');
    expect(ctx.locals._permalinkRewrite).toBe(true);
    expect(ctx.locals._permalinkSourcePath).toBe('/archives/123/');
  });
  it('runs paginated URLs through bootstrap, cache policy, and finalization', async () => {
    const waitUntil = vi.fn();
    const putSpy = vi.spyOn(caches.default, 'put');
    const request = new Request(`${SITE}/page/2/?sort=date`, { method: 'GET' });
    const next = vi.fn(async () => new Response('page two', { status: 200 }));
    const ctx = {
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil } },
    } as any;

    const response = await onRequest(ctx, next) as Response;
    expect(next).toHaveBeenCalledWith('/?sort=date');
    expect(ctx.locals._page).toBe(2);
    expect(ctx.locals._typechoCore?.db).toBe(testDb);
    expect(response.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');

    // The paginated homepage is part of the fixed public cache surface; its
    // cache entry (keyed by the original /page/2/ URL) must be persisted.
    const pagePutIndex = putSpy.mock.calls.findIndex(([req]) => {
      const key = typeof req === 'string' ? req : req instanceof Request ? req.url : String(req);
      return key.includes('/page/2/');
    });
    expect(pagePutIndex).toBeGreaterThanOrEqual(0);
    expect(waitUntil).toHaveBeenCalledWith(putSpy.mock.results[pagePutIndex]?.value);
    putSpy.mockRestore();
  });

  it('bypasses all D1 bootstrap work for public uploads', async () => {
    resetIsolateBoot();
    d1Stub = {
      prepare: vi.fn(() => {
        throw new Error('uploads must not touch D1');
      }),
      batch: vi.fn(() => {
        throw new Error('uploads must not touch D1');
      }),
    } as any;

    const request = new Request(`${SITE}/usr/uploads/2026/07/image.jpg`);
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
    } as any;
    const response = await onRequest(
      ctx,
      async () => new Response('image', { status: 200 }),
    ) as Response;

    expect(response.status).toBe(200);
    expect(d1Stub.prepare).not.toHaveBeenCalled();
    expect(d1Stub.batch).not.toHaveBeenCalled();
  });

  // ── Error handling: specific error types ──

  it('returns 302→/install when tables truly missing, not 500', async () => {
    resetIsolateBoot();
    // Override D1 stub to report no tables
    d1Stub = createD1Stub(testDb);
    (d1Stub as any).prepare = () => ({
      first: () => Promise.reject(new Error('D1_ERROR: no such table: typecho_options')),
      bind() { return this; },
      run: () => Promise.resolve({}),
    });

    const request = new Request(`${SITE}/`, { method: 'GET' });
    const ctx = { request, url: new URL(`${SITE}/`), locals: {}, redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }), rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }) } as any;
    const response = await onRequest(ctx, async () => new Response('ok', { status: 200 })) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/install');
  });

  it('returns 500 when D1 unreachable, not 302 redirect', async () => {
    resetIsolateBoot();
    // Simulate D1 failure (not tables-missing)
    d1Stub = {
      prepare: () => { throw new Error('D1 unreachable'); },
      batch: () => Promise.resolve([]),
    } as any;

    const request = new Request(`${SITE}/`, { method: 'GET' });
    const ctx = { request, url: new URL(`${SITE}/`), locals: {}, redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }), rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }) } as any;
    const response = await onRequest(ctx, async () => new Response('ok', { status: 200 })) as Response;
    expect(response.status).toBe(500);
  });
});
describe('Middleware: activated plugin routes (registry imported by middleware)', () => {
  // The middleware statically imports virtual:typecho-plugin-registry (stubbed
  // in tests/__mocks__/plugin-registry.ts with the workspace plugin loaders),
  // so loaders are already registered before setActivatedPlugins runs on this
  // first request — the exact ordering production relies on for a cold
  // isolate. Without that import this test 404s, proving the regression.
  beforeAll(async () => {
    // Later error-handling tests replace d1Stub and reset isolate boot; the
    // plugin-route tests need a healthy D1 stub again.
    d1Stub = createD1Stub(testDb);
    resetIsolateBoot();
    // Invalidate any 60s options snapshot so loadOptions re-reads the rows below.
    advanceOptionsSnapshotGeneration();
    await testDb.insert(schema.options).values({
      name: 'activatedPlugins',
      user: 0,
      value: JSON.stringify(['typecho-plugin-webdav']),
    });
    await testDb.insert(schema.options).values({
      name: 'plugin:typecho-plugin-webdav',
      user: 0,
      value: JSON.stringify({
        routePath: '/webdav',
        protocolEnabled: 'true',
        mounts: [{ mount: '', provider: 'r2', bindingName: 'BUCKET', prefix: '' }],
      }),
    });
  });

  it('claims GET /webdav with a Basic-auth challenge instead of 404', async () => {
    const request = new Request(`${SITE}/webdav`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, async () => new Response('not found', { status: 404 })) as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm="Typecho WebDAV"');
  });

  it('answers OPTIONS /webdav with 204 and DAV capabilities', async () => {
    const request = new Request(`${SITE}/webdav`, { method: 'OPTIONS' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, async () => new Response('not found', { status: 404 })) as Response;
    expect(response.status).toBe(204);
    expect(response.headers.get('DAV')).toBe('1, 2');
  });

  it('leaves non-WebDAV paths untouched (still 404)', async () => {
    const request = new Request(`${SITE}/webdavish`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const response = await onRequest(ctx, async () => new Response('not found', { status: 404 })) as Response;
    expect(response.status).toBe(404);
  });

  it('lets the default page pattern claim /webdav over the plugin route (system routes > plugin routes)', async () => {
    // A published page whose slug collides with the WebDAV plugin entry:
    // the default page pattern /{slug} claims the path first, so the
    // plugin's Basic-auth handler must not shadow the page.
    await testDb.insert(schema.contents).values({
      cid: 880, title: 'WebDAV Page', slug: 'webdav', type: 'page', status: 'publish',
      authorId: 1, created: Math.floor(Date.now() / 1000),
    });
    const request = new Request(`${SITE}/webdav`, { method: 'GET' });
    const ctx = {
      request,
      url: new URL(request.url),
      locals: {},
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/880/');
  });
});

describe('Middleware: content path whitelist (default URLs rejected once custom patterns are set)', () => {
  beforeAll(async () => {
    d1Stub = createD1Stub(testDb);
    resetIsolateBoot();
    // Invalidate the 60s options snapshot so loadOptions re-reads the rows below.
    advanceOptionsSnapshotGeneration();
    await testDb.insert(schema.options).values([
      { name: 'permalinkPattern', user: 0, value: '/post/{slug}/' },
      { name: 'pagePattern', user: 0, value: '/pages/{slug}/' },
      { name: 'categoryPattern', user: 0, value: '/topics/{slug}/' },
    ]);
    await testDb.insert(schema.users).values({
      name: 'alice', mail: 'alice@example.com', group: 'editor', authCode: 'x',
    });
    const author = (await testDb.query.users.findFirst())!;
    await testDb.insert(schema.contents).values([
      {
        cid: 123, title: 'Hello', slug: 'hello-world', type: 'post', status: 'publish',
        authorId: author.uid, created: Math.floor(Date.now() / 1000),
      },
      {
        cid: 456, title: 'About', slug: 'about', type: 'page', status: 'publish',
        authorId: author.uid, created: Math.floor(Date.now() / 1000),
      },
      {
        cid: 789, title: 'Draft Post', slug: 'draft-post', type: 'post_draft', status: 'draft',
        authorId: author.uid, created: Math.floor(Date.now() / 1000),
      },
      {
        cid: 790, title: 'Draft Page', slug: 'about-draft', type: 'page_draft', status: 'draft',
        authorId: author.uid, created: Math.floor(Date.now() / 1000),
      },
    ]);
    await testDb.insert(schema.metas).values({
      mid: 1, name: 'Tech', slug: 'tech', type: 'category',
    });
  });

  function makeCtx(path: string, locals: Record<string, unknown> = {}) {
    const request = new Request(`${SITE}${path}`, { method: 'GET' });
    return {
      request,
      url: new URL(request.url),
      locals,
      redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
      rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    } as any;
  }

  it('exempts registered plugin routes from the deprecation check', async () => {
    // Plugin front-end routes are dynamic (route table), not fixed surfaces:
    // once registered, a bare-slug plugin path survives a custom page pattern
    // and reaches request:route instead of a middleware 404. The plugin does
    // not claim this path, so the route falls through to Astro's 404.
    registerPluginRoute('/unit-plugin-route');
    const next = vi.fn(async () => new Response('not found', { status: 404 }));
    const response = await onRequest(makeCtx('/unit-plugin-route'), next) as Response;
    expect(response.status).toBe(404);
    expect(next).toHaveBeenCalled();
  });

  it('serves an activated plugin route under a custom page pattern', async () => {
    // WebDAV is activated earlier in this file; its dynamic route (/webdav,
    // registered by the plugin init) must still be claimed by request:route
    // even though the bare-slug form no longer matches the custom page
    // pattern — priority: system fixed > system routes > plugin routes.
    const next = vi.fn(async () => new Response('not found', { status: 404 }));
    const response = await onRequest(makeCtx('/webdav'), next) as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects direct hits on the unified content entry', async () => {
    // /contents/{cid}/ is the internal rewrite target, never a public URL.
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(makeCtx('/contents/123/'), next) as Response;
    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
  it('hard-404s /archives/{cid}/ once a custom post pattern is configured', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(makeCtx('/archives/123/'), next) as Response;
    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('hard-404s the bare-slug default form once a custom page pattern is configured', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(makeCtx('/about'), next) as Response;
    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('hard-404s /category/{slug}/ (and its pagination) once a custom category pattern is configured', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const response = await onRequest(makeCtx('/category/tech/'), next) as Response;
    expect(response.status).toBe(404);
    expect(next).not.toHaveBeenCalled();

    const pagedNext = vi.fn(async () => new Response('rendered', { status: 200 }));
    const pagedResponse = await onRequest(makeCtx('/category/tech/page/2/'), pagedNext) as Response;
    expect(pagedResponse.status).toBe(404);
    expect(pagedNext).not.toHaveBeenCalled();
  });

  it('rewrites published pages through the custom pattern route', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/pages/about/');
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/456/');
    expect(ctx.locals._permalinkRewrite).toBe(true);
  });

  it('rewrites draft pages through the custom pattern route (author-only at render time)', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/pages/about-draft/');
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/790/');
    expect(ctx.locals._permalinkRewrite).toBe(true);
  });

  it('rewrites draft posts through the custom pattern route (author-only at render time)', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/post/draft-post/');
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/789/');
    expect(ctx.locals._permalinkRewrite).toBe(true);
  });

  it('still rewrites the custom pattern URL to the built-in route and marks locals', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/post/hello-world/');
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/123/');
    expect(ctx.locals._permalinkRewrite).toBe(true);
  });

  it('does not reject the internal rewrite target when locals._permalinkRewrite is set', async () => {
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/contents/123/', { _permalinkRewrite: true });
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalled();
  });

  it('lazily serves a custom WebDAV routePath under a custom page pattern (whitelist runs after request:route)', async () => {
    // Cold-isolate scenario: only the default /webdav is in the plugin route
    // table; a configured /dav entry is registered lazily by request:route.
    // The whitelist must run after request:route, otherwise /dav is
    // mistaken for a deprecated bare-slug page form and 404s forever.
    await testDb.insert(schema.options).values({
      name: 'plugin:typecho-plugin-webdav',
      user: 0,
      value: JSON.stringify({
        routePath: '/dav',
        protocolEnabled: 'true',
        mounts: [{ mount: '', provider: 'r2', bindingName: 'BUCKET', prefix: '' }],
      }),
    }).onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: { value: JSON.stringify({
        routePath: '/dav',
        protocolEnabled: 'true',
        mounts: [{ mount: '', provider: 'r2', bindingName: 'BUCKET', prefix: '' }],
      }) },
    });
    advanceOptionsSnapshotGeneration();
    const next = vi.fn(async () => new Response('not found', { status: 404 }));
    const response = await onRequest(makeCtx('/dav'), next) as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm="Typecho WebDAV"');
  });

  it('skips request:route on the internal rewrite target so plugins cannot hijack /contents/{cid}/', async () => {
    const hijack = vi.fn(async (result: any, extra?: { path?: string }) => {
      if (extra?.path === '/contents/123/') {
        return { handled: true, response: new Response('hijacked', { status: 200 }) };
      }
      return result;
    });
    addHook('request:route', 'test-hijack', hijack, 1);
    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/contents/123/', { _permalinkRewrite: true });
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(hijack).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('keeps the page claim when the category pattern overlaps the page pattern', async () => {
    // Page and category slugs live in separate namespaces (contents vs
    // metas), so an overlapping category pattern must not steal a page's
    // own URL: the first claiming branch wins (post > page > category).
    await testDb.insert(schema.options).values({
      name: 'categoryPattern', user: 0, value: '/pages/{slug}/',
    }).onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: { value: '/pages/{slug}/' },
    });
    advanceOptionsSnapshotGeneration();

    const next = vi.fn(async () => new Response('rendered', { status: 200 }));
    const ctx = makeCtx('/pages/about/');
    const response = await onRequest(ctx, next) as Response;
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledWith('/contents/456/');
    expect(ctx.locals._permalinkRewrite).toBe(true);

    // Category-only URLs still fall through to the category branch.
    const catNext = vi.fn(async () => new Response('rendered', { status: 200 }));
    const catCtx = makeCtx('/pages/tech/');
    const catResponse = await onRequest(catCtx, catNext) as Response;
    expect(catResponse.status).toBe(200);
    expect(catNext).toHaveBeenCalledWith('/category/tech/');

    // Restore the block default so later tests keep their assumptions.
    await testDb.insert(schema.options).values({
      name: 'categoryPattern', user: 0, value: '/topics/{slug}/',
    }).onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: { value: '/topics/{slug}/' },
    });
    advanceOptionsSnapshotGeneration();
  });
});
