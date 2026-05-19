/**
 * Integration tests for feed route filtering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: async (_hook: string, data: any) => data,
  applyFilterSafely: async (_hook: string, data: any) => data,
}));

import { GET } from '@/pages/feed/[...type]';

async function seedOptions() {
  const options: Record<string, string> = {
    title: 'Feed Blog',
    description: 'Feed tests',
    siteUrl: 'https://example.com',
    commentsFeedUrl: 'https://example.com/feed/comments',
    permalinkPattern: '/posts/{slug}/',
    pagePattern: '/{slug}.html',
  };
  for (const [name, value] of Object.entries(options)) {
    await testDb.insert(schema.options).values({ name, user: 0, value });
  }
}

async function seedContent(slug: string, overrides: Partial<typeof schema.contents.$inferInsert> = {}) {
  await testDb.insert(schema.contents).values({
    title: slug,
    slug,
    created: 100,
    modified: 100,
    text: 'Body',
    type: 'post',
    status: 'publish',
    allowFeed: '1',
    allowComment: '1',
    ...overrides,
  });
  return (await testDb.query.contents.findFirst({
    where: eq(schema.contents.slug, slug),
  }))!;
}

async function seedComment(cid: number, text: string, status = 'approved') {
  await testDb.insert(schema.comments).values({
    cid,
    author: 'Alice',
    mail: 'alice@example.com',
    text,
    status,
    type: 'comment',
    created: 200,
  });
}

describe('GET /feed/comments', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedOptions();
  });

  it('only includes comments for public feed-enabled posts and pages', async () => {
    const publicPost = await seedContent('public-post');
    const privatePost = await seedContent('private-post', { status: 'private' });
    const passwordPost = await seedContent('password-post', { password: 'secret' });
    const noFeedPost = await seedContent('no-feed-post', { allowFeed: '0' });
    const attachment = await seedContent('attachment-file', { type: 'attachment' });

    await seedComment(publicPost.cid, 'public comment');
    await seedComment(privatePost.cid, 'private comment');
    await seedComment(passwordPost.cid, 'password comment');
    await seedComment(noFeedPost.cid, 'no feed comment');
    await seedComment(attachment.cid, 'attachment comment');
    await seedComment(publicPost.cid, 'waiting comment', 'waiting');

    const res = await GET({ locals: {}, params: { type: 'comments' } } as any);
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(xml).toContain('public comment');
    expect(xml).toContain('https://example.com/posts/public-post/#comment-');
    expect(xml).not.toContain('private comment');
    expect(xml).not.toContain('password comment');
    expect(xml).not.toContain('no feed comment');
    expect(xml).not.toContain('attachment comment');
    expect(xml).not.toContain('waiting comment');
  });
});

describe('GET /feed feedItems clamp (G7-7)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedOptions();
  });

  async function seedManyPosts(n: number) {
    for (let i = 0; i < n; i++) {
      await seedContent(`post-${i}`, { created: 100 + i, modified: 100 + i });
    }
  }

  it('honours options.feedItems within bounds', async () => {
    await testDb.insert(schema.options).values({ name: 'feedItems', user: 0, value: '7' });
    await seedManyPosts(15);
    // Empty type = RSS 2.0 default. Per the route's startsWith('rss') check,
    // 'rss' or 'rss2' would land on RSS 1.0 (RDF), which we don't want here.
    const res = await GET({ locals: {}, params: { type: '' } } as any);
    const xml = await res.text();
    const items = (xml.match(/<item>/g) || []).length;
    expect(items).toBe(7);
  });

  it('clamps oversized feedItems to 50', async () => {
    await testDb.insert(schema.options).values({ name: 'feedItems', user: 0, value: '500' });
    await seedManyPosts(60);
    const res = await GET({ locals: {}, params: { type: '' } } as any);
    const xml = await res.text();
    const items = (xml.match(/<item>/g) || []).length;
    expect(items).toBe(50);
  });

  it('clamps undersized feedItems to 5', async () => {
    await testDb.insert(schema.options).values({ name: 'feedItems', user: 0, value: '1' });
    await seedManyPosts(20);
    const res = await GET({ locals: {}, params: { type: '' } } as any);
    const xml = await res.text();
    const items = (xml.match(/<item>/g) || []).length;
    expect(items).toBe(5);
  });

  it('falls back to default 10 when feedItems is unset', async () => {
    await seedManyPosts(20);
    const res = await GET({ locals: {}, params: { type: '' } } as any);
    const xml = await res.text();
    const items = (xml.match(/<item>/g) || []).length;
    expect(items).toBe(10);
  });
});

describe('GET /feed description vs content (G7-6)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedOptions();
  });

  it('emits content:encoded only when feedFullText is on', async () => {
    await testDb.insert(schema.options).values({ name: 'feedFullText', user: 0, value: '1' });
    await seedContent('full-text-post', { text: 'A long body that becomes the full content.' });
    const res = await GET({ locals: {}, params: { type: '' } } as any);
    const xml = await res.text();
    expect(xml).toContain('<content:encoded>');
    expect(xml).toContain('<description>');
  });

  it('omits content:encoded when feedFullText is off', async () => {
    await testDb.insert(schema.options).values({ name: 'feedFullText', user: 0, value: '0' });
    await seedContent('excerpt-only-post', { text: 'A long body that should only show as excerpt.' });
    const res = await GET({ locals: {}, params: { type: '' } } as any);
    const xml = await res.text();
    expect(xml).not.toContain('<content:encoded>');
    expect(xml).toContain('<description>');
  });
});
