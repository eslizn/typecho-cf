import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({ env: { DB: {} } }));

import { GET as sitemapIndex } from '@/pages/sitemap.xml';
import { GET as sitemapShard } from '@/pages/sitemap/[part].xml';
import { GET as robots } from '@/pages/robots.txt';

const SITE_URL = 'https://example.com';
const NOW = 1_800_000_000;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  testDb = await createTestDb();
  await testDb.insert(schema.options).values([
    { name: 'siteUrl', user: 0, value: SITE_URL },
    { name: 'permalinkPattern', user: 0, value: '/posts/{slug}/' },
    { name: 'pagePattern', user: 0, value: '/{slug}.html' },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  testDb.$client.close();
  await disposeTestDb(testDb);
});

async function insertManyPosts(count: number) {
  for (let start = 0; start < count; start += 100) {
    const posts = Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
      const id = start + offset;
      return {
        title: `Post ${id}`,
        slug: `post-${id}`,
        type: 'post',
        status: 'publish',
        created: 1_000,
        modified: 1_000, // Equal timestamps exercise the cid tie-breaker.
      };
    });
    await testDb.insert(schema.contents).values(posts);
  }
}

function indexLocations(xml: string): URL[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match =>
    new URL(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')),
  );
}

describe('GET /sitemap.xml and sitemap shards', () => {
  it('covers more than 5000 public URLs without gaps or duplicates across keyset shards', async () => {
    await insertManyPosts(5005);
    await testDb.insert(schema.contents).values([
      { title: 'About', slug: 'about', type: 'page', status: 'publish', created: 1_000, modified: 1_000 },
      { title: 'Future', slug: 'future', type: 'post', status: 'publish', created: NOW + 60, modified: NOW + 60 },
      { title: 'Private', slug: 'private', type: 'post', status: 'private', created: 1_000, modified: 1_000 },
      { title: 'Attachment', slug: 'attachment', type: 'attachment', status: 'publish', created: 1_000, modified: 1_000 },
      { title: 'Revision', slug: 'post-0', type: 'revision', status: 'draft', created: 1_000, modified: 1_000 },
    ]);

    const indexResponse = await sitemapIndex({ locals: {} } as any);
    const indexXml = await indexResponse.text();
    const locations = indexLocations(indexXml);
    expect(indexResponse.status).toBe(200);
    expect(indexXml).toContain('<sitemapindex');
    expect(locations).toHaveLength(6);
    expect(locations.every(location => location.pathname.match(/^\/sitemap\/[1-6]\.xml$/) && location.searchParams.has('cursor'))).toBe(true);

    const allUrls: string[] = [];
    for (const location of locations) {
      const part = location.pathname.match(/\/(\d+)\.xml$/)![1];
      const response = await sitemapShard({
        params: { part },
        url: location,
        locals: {},
      } as any);
      expect(response.status).toBe(200);
      const xml = await response.text();
      expect(xml).toContain('<urlset');
      expect((xml.match(/<url>/g) ?? []).length).toBeLessThanOrEqual(1000);
      allUrls.push(...[...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match =>
        match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'),
      ));
    }

    const expected = [
      ...Array.from({ length: 5005 }, (_, id) => `${SITE_URL}/posts/post-${id}/`),
      `${SITE_URL}/about.html`,
    ].sort();
    expect(allUrls).toHaveLength(expected.length);
    expect(new Set(allUrls).size).toBe(expected.length);
    expect([...allUrls].sort()).toEqual(expected);
  });

  it('escapes XML content and keeps robots.txt pointed at the index', async () => {
    await testDb.insert(schema.contents).values({
      title: 'Query', slug: 'a&b', type: 'post', status: 'publish', created: 1_000, modified: 1_000,
    });
    const index = await sitemapIndex({ locals: {} } as any);
    const location = indexLocations(await index.text())[0];
    const part = location.pathname.match(/\/(\d+)\.xml$/)![1];
    const shard = await sitemapShard({ params: { part }, url: location, locals: {} } as any);
    expect(await shard.text()).toContain('https://example.com/posts/a&amp;b/');

    const robotsResponse = await robots({ locals: {} } as any);
    expect(await robotsResponse.text()).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  it.each([
    ['0', null],
    ['abc', null],
    ['9007199254740992', null],
    ['2', null],
    ['1', 'broken'],
  ])('rejects invalid part/cursor input %s %s', async (part, cursor) => {
    const url = new URL(`${SITE_URL}/sitemap/${part}.xml`);
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const response = await sitemapShard({ params: { part }, url, locals: {} } as any);
    expect(response.status).toBe(404);
  });
});
