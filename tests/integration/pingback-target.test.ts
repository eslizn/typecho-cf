/**
 * Pingback target resolution.
 *
 * Regression: the route loaded up to 1000 full content rows (body included)
 * and compared permalinks in JS, so targets stopped resolving once a site had
 * more than 1000 published posts and every unauthenticated call cost a
 * multi-megabyte read.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  env: { DB: null, BUCKET: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() } },
  caches: { default: { match: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import { resolvePingbackTarget } from '@/pages/api/pingback';

const OPTIONS = {
  siteUrl: 'https://example.com',
  permalinkPattern: '/archives/{cid}/',
  pagePattern: '/{slug}.html',
} as any;

// The helper is typed against the D1 Drizzle handle; the fixture is libsql.
const resolve = (target: string) =>
  resolvePingbackTarget(testDb as unknown as Parameters<typeof resolvePingbackTarget>[0], OPTIONS, target);

describe('resolvePingbackTarget', () => {
  it('resolves canonical post and page permalinks', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'Post', slug: 'hello', type: 'post', status: 'publish', created: 100, modified: 100, text: 'x',
    });
    const [post] = await testDb.select({ cid: schema.contents.cid }).from(schema.contents);
    await testDb.insert(schema.contents).values({
      title: 'Page', slug: 'about', type: 'page', status: 'publish', created: 100, modified: 100, text: 'x',
    });

    expect(await resolve('https://example.com/archives/1/')).toEqual({ cid: post.cid });
    expect(await resolve('https://example.com/about.html')).not.toBeNull();
  });

  it('refuses foreign origins, unpublished content, and unknown paths', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values([
      { title: 'Draft', slug: 'd1', type: 'post_draft', status: 'draft', created: 100, modified: 100, text: 'x' },
      { title: 'Future', slug: 'f1', type: 'post', status: 'publish', created: 4_000_000_000, modified: 100, text: 'x' },
    ]);

    expect(await resolve('https://evil.example/archives/1/')).toBeNull();
    expect(await resolve('https://example.com/archives/999/')).toBeNull();
    expect(await resolve('https://example.com/d1.html')).toBeNull();
    expect(await resolve('https://example.com/f1.html')).toBeNull();
    expect(await resolve('not-a-url')).toBeNull();
  });
});
