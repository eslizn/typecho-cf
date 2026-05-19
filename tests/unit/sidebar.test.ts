/**
 * Unit tests for src/lib/sidebar.ts — sidebar data loading and nav pages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { loadSidebarData, loadNavPages } from '@/lib/sidebar';

const siteUrl = 'https://example.com';

beforeEach(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('loadSidebarData', () => {
  it('returns empty data when database has no content', async () => {
    const data = await loadSidebarData(testDb, siteUrl);
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

    const data = await loadSidebarData(testDb, siteUrl);
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

    const data = await loadSidebarData(testDb, siteUrl);
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

    const data = await loadSidebarData(testDb, siteUrl);
    expect(data.recentComments).toHaveLength(1);
    expect(data.recentComments[0].author).toBe('Commenter');
    expect(data.recentComments[0].permalink).toContain('#comment-');
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

    const data = await loadSidebarData(testDb, siteUrl);
    expect(data.recentComments).toEqual([]);
  });

  it('returns categories sorted by order', async () => {
    await testDb.insert(schema.metas).values({
      name: 'Tech', slug: 'tech', type: 'category', order: 2, count: 5,
    });
    await testDb.insert(schema.metas).values({
      name: 'Life', slug: 'life', type: 'category', order: 1, count: 3,
    });

    const data = await loadSidebarData(testDb, siteUrl);
    expect(data.categories).toHaveLength(2);
    expect(data.categories[0].name).toBe('Life');
    expect(data.categories[1].name).toBe('Tech');
    expect(data.categories[0].permalink).toContain('/category/life/');
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
