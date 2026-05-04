/**
 * Integration tests for feed route filtering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: ReturnType<typeof createTestDb>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return {
    ...actual,
    getDb: (_d1: any) => testDb,
    schema: actual.schema,
  };
});

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: async (_hook: string, data: any) => data,
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
    testDb = createTestDb();
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
