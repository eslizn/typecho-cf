/**
 * Keyset pagination + exact counts for public archive pages.
 *
 * The list query orders by (created DESC, cid DESC) and paginates with a
 * (created, cid) cursor instead of OFFSET; count(*) stays exact so page
 * numbers are accurate.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { sql } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { prepareCategoryData, prepareIndexData, prepareMonthData } from '@/lib/page-data';
import type { RequestContext } from '@/lib/context';
import { addHook, removePluginHooks } from '@/lib/plugin';

describe('archive keyset pagination', () => {
  it('paginates deep pages without overlap and in descending order', async () => {
    testDb = await createTestDb();
    for (let created = 1; created <= 12; created++) {
      await testDb.insert(schema.contents).values({
        title: `post-${created}`,
        slug: `p${created}`,
        type: 'post',
        status: 'publish',
        created,
        modified: created,
        text: `body-${created}`,
      });
    }

    const ctx = await buildCtx();
    const page2 = await prepareIndexData(
      ctx,
      'https://example.com/',
      { _page: 2 },
      new URL('https://example.com/page/2/'),
    );
    const page3 = await prepareIndexData(
      ctx,
      'https://example.com/',
      { _page: 3 },
      new URL('https://example.com/page/3/'),
    );

    expect(page2.posts.map(post => post.created)).toEqual([7, 6, 5, 4, 3]);
    expect(page3.posts.map(post => post.created)).toEqual([2, 1]);
    expect(page2.posts.map(post => post.cid)).not.toEqual(page3.posts.map(post => post.cid));
    expect(page2.pagination.currentPage).toBe(2);
    expect(page3.pagination.currentPage).toBe(3);
  });

  it('returns the entire first page when an out-of-range page clamps to it', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values([{ created: 1 }, { created: 2 }]);
    const ctx = await buildCtx();
    const url = new URL('https://example.com/page/2/');
    const result = await prepareIndexData(ctx, url.href, { _page: 2 }, url);
    expect(result.pagination.currentPage).toBe(1);
    expect(result.posts.map(post => post.created)).toEqual([2, 1]);
  });

  it('uses numeric category links for sidebar, post terms and pagination', async () => {
    testDb = await createTestDb();
    const [category] = await testDb.insert(schema.metas).values({ type: 'category', slug: 'news' }).returning();
    const posts = await testDb.insert(schema.contents).values([{ created: 1 }, { created: 2 }]).returning();
    await testDb.insert(schema.relationships).values(posts.map(post => ({ cid: post.cid, mid: category.mid })));
    const ctx = await buildCtx();
    ctx.options.categoryPattern = '/c/{mid}/';
    ctx.options.pageSize = 1;
    const path = `https://example.com/c/${category.mid}/`;
    const result = await prepareCategoryData(ctx, 'news', path, {}, new URL(path));
    if (result instanceof Response) throw new Error('Expected an archive');
    expect(result.pagination.nextUrl).toBe(`${path}page/2/`);
    expect(result.posts[0].categories[0].permalink).toBe(path);
    expect(result.sidebarData.categories[0].permalink).toBe(path);
  });

  it('archives posts in the site-local month and agrees with sidebar month links', async () => {
    testDb = await createTestDb();
    const start = Date.UTC(2026, 0, 31, 16) / 1000;
    const end = Date.UTC(2026, 1, 28, 16) / 1000;
    await testDb.insert(schema.contents).values([
      { created: start - 1 }, { created: start }, { created: end - 1 }, { created: end },
      { created: start, status: 'private' }, { created: start, type: 'page' },
    ]);
    const ctx = await buildCtx();
    ctx.options.timezone = 'Asia/Shanghai';
    ctx.options.pageSize = 1;
    const path = 'https://example.com/2026/02/';
    const spy = vi.spyOn(Date, 'now').mockReturnValue((end + 60) * 1000);
    try {
      const result = await prepareMonthData(ctx, 2026, 2, path, {}, new URL(path));
      if (result instanceof Response) throw new Error('Expected a month archive');
      expect(result.posts.map(post => post.created)).toEqual([end - 1]);
      expect(result.pagination.totalItems).toBe(2);
      expect(result.pagination.nextUrl).toBe(`${path}page/2/`);
      expect(result.sidebarData.archives.map(month => month.permalink)).toContain(path);
    } finally {
      spy.mockRestore();
    }
  });

  it('breaks created ties with cid when keyset paginating', async () => {
    testDb = await createTestDb();
    for (let i = 1; i <= 7; i++) {
      await testDb.insert(schema.contents).values({
        title: `tie-${i}`,
        slug: `t${i}`,
        type: 'post',
        status: 'publish',
        created: 100,
        modified: 100,
        text: `body-${i}`,
      });
    }

    const ctx = await buildCtx();
    const page1 = await prepareIndexData(
      ctx,
      'https://example.com/',
      {},
      new URL('https://example.com/'),
    );
    const page2 = await prepareIndexData(
      ctx,
      'https://example.com/',
      { _page: 2 },
      new URL('https://example.com/page/2/'),
    );

    expect(page1.posts.map(post => post.cid)).toEqual([7, 6, 5, 4, 3]);
    expect(page2.posts.map(post => post.cid)).toEqual([2, 1]);
  });

  it('reports exact pagination totals past the old count cap', async () => {
    testDb = await createTestDb();
    // Seed in chunks. 1005 sequential single-row awaits blew this case's 30s
    // budget on a loaded runner (the only flaky case in the suite), which made
    // CI red at random. Chunks of 100 stay well under SQLite's parameter cap.
    const rows = Array.from({ length: 1005 }, (_, index) => {
      const created = index + 1;
      return {
        title: `bulk-${created}`,
        slug: `b${created}`,
        type: 'post',
        status: 'publish',
        created,
        modified: created,
        text: `body-${created}`,
      };
    });
    for (let start = 0; start < rows.length; start += 100) {
      await testDb.insert(schema.contents).values(rows.slice(start, start + 100));
    }

    const ctx = await buildCtx();
    const props = await prepareIndexData(
      ctx,
      'https://example.com/',
      {},
      new URL('https://example.com/'),
    );

    expect(props.posts).toHaveLength(5);
    expect(props.pagination.totalItems).toBe(1005);
    expect(props.pagination.totalPages).toBe(201);
    expect(props.pagination.hasNext).toBe(true);
  }, 30000);

  it('keeps archive lookup statements under the D1 parameter cap at pageSize 100', async () => {
    testDb = await createTestDb();
    const authors = Array.from({ length: 100 }, (_, index) => ({
      uid: index + 1,
      name: `author-${index}`,
      group: 'contributor',
      authCode: `code-${index}`,
      created: 1,
    }));
    await testDb.insert(schema.users).values(authors);
    const rows = Array.from({ length: 100 }, (_, index) => ({
      title: `page-${index}`,
      slug: `page-${index}`,
      type: 'post',
      status: 'publish',
      created: 1000 - index,
      modified: 1000 - index,
      text: `body-${index}`,
      authorId: index + 1,
    }));
    for (let start = 0; start < rows.length; start += 50) {
      await testDb.insert(schema.contents).values(rows.slice(start, start + 50));
    }

    const batches: unknown[][] = [];
    const originalBatch = testDb.batch.bind(testDb);
    (testDb as any).batch = async (statements: unknown[]) => {
      batches.push(statements);
      return originalBatch(statements as any);
    };
    try {
      const ctx = await buildCtx();
      (ctx.options as any).pageSize = 100;
      const props = await prepareIndexData(
        ctx,
        'https://example.com/',
        {},
        new URL('https://example.com/'),
      );
      expect(props.posts).toHaveLength(100);
    } finally {
      (testDb as any).batch = originalBatch;
    }

    const statements = batches.flat() as Array<{ toSQL(): { sql: string; params: unknown[] } }>;
    const paramCounts = statements.map(statement => statement.toSQL().params.length);
    expect(paramCounts.length).toBeGreaterThan(0);
    expect(Math.max(...paramCounts)).toBeLessThanOrEqual(100);
    // A single 100-id IN list plus type = 101 parameters, so the category
    // lookup must have been split across at least two statements.
    const categoryStatements = statements.filter(statement => {
      const text = statement.toSQL().sql;
      return text.includes('typecho_relationships') && text.includes('typecho_metas');
    });
    expect(categoryStatements.length).toBeGreaterThanOrEqual(2);
  });

  it('runs archive lifecycle, query, and content display hooks', async () => {
    testDb = await createTestDb();
    for (let created = 1; created <= 2; created++) {
      await testDb.insert(schema.contents).values({
        title: `hook-post-${created}`,
        slug: `hook-${created}`,
        type: 'post',
        status: 'publish',
        created,
        modified: created,
        text: `body-${created}`,
      });
    }

    const pluginId = 'archive-hook-test';
    const events: string[] = [];
    addHook('archive:init', pluginId, (context: any) => events.push(`init:${context.archiveType}`));
    addHook('archive:index', pluginId, (context: any) => events.push(`index:${context.archiveType}`));
    addHook('archive:query', pluginId, (state: any) => ({
      ...state,
      pageSize: 1,
      extraWhere: sql`${schema.contents.title} = ${'hook-post-1'}`,
    }));
    addHook('content:data', pluginId, (post: any) => ({ ...post, title: `${post.title}-data` }));
    addHook('content:title', pluginId, (title: string) => `${title}-title`);
    addHook('content:excerpt', pluginId, (excerpt: string) => `${excerpt}-excerpt`);

    try {
      const ctx = await buildCtx(new Set([pluginId]));
      const props = await prepareIndexData(
        ctx,
        'https://example.com/',
        {},
        new URL('https://example.com/'),
      );

      expect(props.posts).toHaveLength(1);
      expect(props.posts[0].title).toBe('hook-post-1-data-title');
      expect(props.posts[0].excerpt).toContain('-excerpt');
      expect(events).toEqual(['init:index', 'index:index']);
    } finally {
      removePluginHooks(pluginId);
    }
  });
});

async function buildCtx(activatedPlugins = new Set<string>()) {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      pageSize: 5,
      categoryPattern: '/category/{slug}/',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      commentsAvatarRating: 'G',
      commentsOrder: 'ASC',
      timezone: 'UTC',
      commentsAntiSpam: 0,
      secret: '',
    } as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
    activatedPlugins,
  } as unknown as RequestContext;
}
