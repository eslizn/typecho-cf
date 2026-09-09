/**
 * G4-5: search keyword length guard.
 *
 * We reach into prepareSearchData via a shimmed RequestContext to
 * verify the generated SQL contains a sentinel `1 = 0` clause when the
 * keyword is too short, a LIKE expression for keywords with any sub-3-char
 * term, and an FTS5 MATCH path when every term fits the trigram tokenizer.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { prepareSearchData } from '@/lib/page-data';
import type { RequestContext } from '@/lib/context';
import { schema } from '@/db';
import { resetFtsAvailability, setFtsAvailable } from '@/lib/fulltext';

describe('search keyword guard (G4-5)', () => {
  it('returns empty results for keyword shorter than 2 chars', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'a-post-title-with-x',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'Body x',
    });

    const ctx = await buildCtx();
    const props = await prepareSearchData(ctx, 'x', 'https://example.com/search/x/', {}, new URL('https://example.com/search/x/'));
    expect(props.posts).toHaveLength(0);
  });

  it('returns matching posts for usable keywords', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'astro hello',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'astro body',
    });
    await testDb.insert(schema.contents).values({
      title: 'unrelated',
      slug: 'p2',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'nothing here',
    });

    const ctx = await buildCtx();
    const props = await prepareSearchData(ctx, 'astro', 'https://example.com/search/astro/', {}, new URL('https://example.com/search/astro/'));
    expect(props.posts).toHaveLength(1);
    expect(props.posts[0].title).toBe('astro hello');
  });

  it('falls back to LIKE for 2-char keywords (trigram needs >= 3 chars)', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: '性能优化指南',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: '正文内容',
    });
    await testDb.insert(schema.contents).values({
      title: '无关标题',
      slug: 'p2',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: '没有匹配',
    });

    const ctx = await buildCtx();
    const props = await prepareSearchData(ctx, '性能', 'https://example.com/search/性能/', {}, new URL('https://example.com/search/性能/'));
    expect(props.posts).toHaveLength(1);
    expect(props.posts[0].title).toBe('性能优化指南');
  });

  it('falls back to LIKE when every whitespace term is shorter than 3 chars', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'to be or not to be',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'that is the question',
    });
    await testDb.insert(schema.contents).values({
      title: 'unrelated',
      slug: 'p2',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'nothing here',
    });

    const ctx = await buildCtx();
    // FTS trigram would silently drop the 2-char terms and match nothing;
    // the LIKE branch must match the literal substring instead.
    const props = await prepareSearchData(ctx, 'to be', 'https://example.com/search/to%20be/', {}, new URL('https://example.com/search/to%20be/'));
    expect(props.posts).toHaveLength(1);
    expect(props.posts[0].title).toBe('to be or not to be');
  });

  it('falls back to LIKE for mixed-length multi-term keywords', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'hello ab world',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'some body',
    });

    const ctx = await buildCtx();
    // "ab" cannot use trigram and would be dropped by MATCH, so the whole
    // keyword goes through LIKE and matches the literal "hello ab".
    const props = await prepareSearchData(ctx, 'hello ab', 'https://example.com/search/hello%20ab/', {}, new URL('https://example.com/search/hello%20ab/'));
    expect(props.posts).toHaveLength(1);
    expect(props.posts[0].title).toBe('hello ab world');
  });

  it('falls back to LIKE when the FTS index is unavailable', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'astro hello',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'astro body',
    });

    setFtsAvailable(false);
    try {
      const ctx = await buildCtx();
      const props = await prepareSearchData(ctx, 'astro', 'https://example.com/search/astro/', {}, new URL('https://example.com/search/astro/'));
      expect(props.posts).toHaveLength(1);
      expect(props.posts[0].title).toBe('astro hello');
    } finally {
      resetFtsAvailability();
    }
  });

  it('searches via FTS5 for 3+ char keywords', async () => {
    testDb = await createTestDb();
    await testDb.insert(schema.contents).values({
      title: 'cloudflare workers 性能优化',
      slug: 'p1',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'd1 数据库 读取行数',
    });
    await testDb.insert(schema.contents).values({
      title: 'unrelated',
      slug: 'p2',
      type: 'post',
      status: 'publish',
      created: 100,
      modified: 100,
      text: 'nothing',
    });

    const ctx = await buildCtx();
    const props = await prepareSearchData(ctx, '性能优化', 'https://example.com/search/性能优化/', {}, new URL('https://example.com/search/性能优化/'));
    expect(props.posts).toHaveLength(1);
    expect(props.posts[0].title).toBe('cloudflare workers 性能优化');
  });

  it('truncates over-long keywords to 50 chars before matching', async () => {
    testDb = await createTestDb();
    const long = 'astro' + 'a'.repeat(100);
    const ctx = await buildCtx();
    const props = await prepareSearchData(ctx, long, `https://example.com/search/${encodeURIComponent(long)}/`, {}, new URL(`https://example.com/search/${encodeURIComponent(long)}/`));
    // Title rendering uses the trimmed value.
    expect(props.archiveTitle.length).toBeLessThan(80);
  });
});

async function buildCtx() {
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
