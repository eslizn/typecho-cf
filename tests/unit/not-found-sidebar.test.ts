/**
 * 404 responses must skip the sidebar widget queries (recent posts/comments,
 * categories, monthly archives) so bot storms on dead URLs do not rebuild
 * sidebar snapshots — nav pages are still loaded for the header.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('@/lib/sidebar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sidebar')>('@/lib/sidebar');
  return {
    ...actual,
    loadSidebarData: vi.fn(async () => {
      throw new Error('loadSidebarData must not run for 404 pages');
    }),
  };
});

import { prepareNotFoundData } from '@/lib/page-data';
import { loadSidebarData } from '@/lib/sidebar';
import type { RequestContext } from '@/lib/context';
import { schema } from '@/db';

describe('prepareNotFoundData', () => {
  it('renders without loading sidebar widget data', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'About',
      slug: 'about',
      type: 'page',
      status: 'publish',
      order: 1,
      created: Math.floor(Date.now() / 1000),
    });

    const ctx = buildCtx();
    const props = await prepareNotFoundData(ctx, 'https://example.com/dead-link');

    expect(loadSidebarData).not.toHaveBeenCalled();
    expect(props.sidebarData.recentPosts).toEqual([]);
    expect(props.pages).toHaveLength(1);
  });
});

function buildCtx() {
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
    activatedPlugins: new Set<string>(),
  } as unknown as RequestContext;
}
