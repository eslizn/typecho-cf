/**
 * Unit tests for src/lib/sidebar.ts — sidebar data loading and nav pages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

type SidebarTestDatabase = TestDatabase & Parameters<typeof loadSidebarData>[1];
let testDb: SidebarTestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { loadSidebarData, loadNavPages } from '@/lib/sidebar';

const siteUrl = 'https://example.com';
const mockPluginCtx = { activatedPlugins: new Set<string>() };

beforeEach(async () => {
  testDb = await createTestDb() as SidebarTestDatabase;
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('loadSidebarData', () => {
  it('returns empty data when database has no content', async () => {
    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);
    expect(data.recentPosts).toEqual([]);
    expect(data.recentComments).toEqual([]);
    expect(data.categories).toEqual([]);
    expect(data.archives).toEqual([]);
  });

  it('returns recent published posts', async () => {
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.contents).values({
      title: 'Test Post',
      slug: 'test-post',
      created: now,
      type: 'post',
      status: 'publish',
    });

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);
    expect(data.recentPosts).toHaveLength(1);
    expect(data.recentPosts[0].title).toBe('Test Post');
    expect(data.recentPosts[0].permalink).toContain('/archives/');
  });

  it('excludes draft and private posts from recent posts', async () => {
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.contents).values({
      title: 'Draft', slug: 'draft', created: now, type: 'post', status: 'draft',
    });
    await testDb.insert(schema.contents).values({
      title: 'Private', slug: 'private', created: now, type: 'post', status: 'private',
    });

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);
    expect(data.recentPosts).toEqual([]);
  });

  it('returns approved comments as recent comments', async () => {
    const now = Math.floor(Date.now() / 1000);
    const post = await testDb.insert(schema.contents).values({
      title: 'Post', slug: 'post', created: now, type: 'post', status: 'publish',
    }).returning({ cid: schema.contents.cid });
    await testDb.insert(schema.comments).values({
      cid: post[0]!.cid, created: now, author: 'Commenter', text: 'Great post!', status: 'approved',
    });

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);
    expect(data.recentComments).toHaveLength(1);
    expect(data.recentComments[0].author).toBe('Commenter');
    expect(data.recentComments[0].permalink).toContain('#comment-');
  });

  it('builds recent comment permalinks from the configured page pattern', async () => {
    const now = Math.floor(Date.now() / 1000);
    const page = await testDb.insert(schema.contents).values({
      title: 'About', slug: 'about', created: now, type: 'page', status: 'publish',
    }).returning({ cid: schema.contents.cid });
    await testDb.insert(schema.comments).values({
      cid: page[0]!.cid, created: now, author: 'Commenter', text: 'Nice page!', status: 'approved',
    });

    const data = await loadSidebarData(
      mockPluginCtx, testDb, siteUrl,
      undefined, undefined, '/pages/{slug}/',
    );
    expect(data.recentComments).toHaveLength(1);
    expect(data.recentComments[0].permalink).toContain('/pages/about/#comment-');
  });

  it('excludes non-approved comments from recent comments', async () => {
    const now = Math.floor(Date.now() / 1000);
    const post = await testDb.insert(schema.contents).values({
      title: 'Post', slug: 'post', created: now, type: 'post', status: 'publish',
    }).returning({ cid: schema.contents.cid });
    await testDb.insert(schema.comments).values({
      cid: post[0]!.cid, created: now, author: 'Spammer', text: 'spam', status: 'spam',
    });
    await testDb.insert(schema.comments).values({
      cid: post[0]!.cid, created: now, author: 'Pending', text: 'pending', status: 'waiting',
    });

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);
    expect(data.recentComments).toEqual([]);
  });

  it('returns categories sorted by order', async () => {
    await testDb.insert(schema.metas).values({
      name: 'Tech', slug: 'tech', type: 'category', order: 2, count: 5,
    });
    await testDb.insert(schema.metas).values({
      name: 'Life', slug: 'life', type: 'category', order: 1, count: 3,
    });

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);
    expect(data.categories).toHaveLength(2);
    expect(data.categories[0].name).toBe('Life');
    expect(data.categories[1].name).toBe('Tech');
    expect(data.categories[0].permalink).toContain('/category/life/');
  });

  it('limits the monthly archives widget to the recent window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const olderThanWindow = now - 14 * 30 * 24 * 3600;
    await testDb.insert(schema.contents).values({
      title: 'Old Post', slug: 'old-post', created: olderThanWindow, type: 'post', status: 'publish',
    });
    await testDb.insert(schema.contents).values({
      title: 'New Post', slug: 'new-post', created: now, type: 'post', status: 'publish',
    });

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl, undefined, undefined, undefined, 77);
    expect(data.archives).toHaveLength(1);
  });

  it('reuses the versioned sidebar snapshot and refreshes after a version change', async () => {
    const first = await loadSidebarData(mockPluginCtx, testDb, siteUrl, undefined, undefined, undefined, 1);
    expect(first.recentPosts).toEqual([]);

    await testDb.insert(schema.contents).values({
      title: 'New Post',
      slug: 'new-post',
      created: Math.floor(Date.now() / 1000),
      type: 'post',
      status: 'publish',
    });

    const sameVersion = await loadSidebarData(mockPluginCtx, testDb, siteUrl, undefined, undefined, undefined, 1);
    const nextVersion = await loadSidebarData(mockPluginCtx, testDb, siteUrl, undefined, undefined, undefined, 2);
    expect(sameVersion.recentPosts).toEqual([]);
    expect(nextVersion.recentPosts).toHaveLength(1);
  });
});

describe('loadNavPages', () => {
  it('returns empty array when no pages exist', async () => {
    const pages = await loadNavPages(testDb, siteUrl);
    expect(pages).toEqual([]);
  });

  it('returns published pages sorted by order', async () => {
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.contents).values({
      title: 'About', slug: 'about', created: now, type: 'page', status: 'publish', order: 2,
    });
    await testDb.insert(schema.contents).values({
      title: 'Contact', slug: 'contact', created: now, type: 'page', status: 'publish', order: 1,
    });

    const pages = await loadNavPages(testDb, siteUrl);
    expect(pages).toHaveLength(2);
    expect(pages[0].title).toBe('Contact');
    expect(pages[1].title).toBe('About');
  });

  it('excludes non-published pages', async () => {
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.contents).values({
      title: 'Hidden', slug: 'hidden', created: now, type: 'page', status: 'hidden',
    });

    const pages = await loadNavPages(testDb, siteUrl);
    expect(pages).toEqual([]);
  });

  it('respects custom page permalink pattern', async () => {
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.contents).values({
      title: 'About', slug: 'about', created: now, type: 'page', status: 'publish', order: 0,
    });

    const pages = await loadNavPages(testDb, siteUrl, '/pages/{slug}/');
    expect(pages[0].permalink).toBe('https://example.com/pages/about/');
  });
});

describe('sidebar content visibility', () => {
  it('hides recent comments whose content is no longer publicly visible', async () => {
    const now = Math.floor(Date.now() / 1000);
    const contents = await testDb.insert(schema.contents).values([
      { title: 'Public', slug: 'public', type: 'post', status: 'publish', created: now - 60, modified: now, text: 'x' },
      { title: 'Private', slug: 'private', type: 'post', status: 'private', created: now - 60, modified: now, text: 'x' },
      { title: 'Draft', slug: 'draft', type: 'post_draft', status: 'draft', created: now - 60, modified: now, text: 'x' },
      { title: 'Scheduled', slug: 'scheduled', type: 'post', status: 'publish', created: now + 3600, modified: now, text: 'x' },
    ]).returning({ cid: schema.contents.cid });

    await testDb.insert(schema.comments).values(contents.map((row, index) => ({
      cid: row.cid,
      created: now,
      author: `author-${index}`,
      text: `comment-${index}`,
      status: 'approved',
    })));

    const data = await loadSidebarData(mockPluginCtx, testDb, siteUrl);

    // Only the comment on the published post may surface in the sidebar: the
    // private/draft/scheduled rows used to leak author, excerpt and permalink.
    expect(data.recentComments.map((comment) => comment.author)).toEqual(['author-0']);
  });

  it('does not list future-scheduled pages in the navigation', async () => {
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.contents).values([
      { title: 'Live', slug: 'live', type: 'page', status: 'publish', created: now - 60 },
      { title: 'Future', slug: 'future', type: 'page', status: 'publish', created: now + 3600 },
    ]);

    const pages = await loadNavPages(testDb, siteUrl);
    expect(pages.map((page) => page.slug)).toEqual(['live']);
  });
});
