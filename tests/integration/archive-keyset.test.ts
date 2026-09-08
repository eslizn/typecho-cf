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

import { prepareIndexData } from '@/lib/page-data';
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
    for (let created = 1; created <= 1005; created++) {
      await testDb.insert(schema.contents).values({
        title: `bulk-${created}`,
        slug: `b${created}`,
        type: 'post',
        status: 'publish',
        created,
        modified: created,
        text: `body-${created}`,
      });
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
      timezone: 0,
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
