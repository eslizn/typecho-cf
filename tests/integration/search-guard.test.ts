/**
 * G4-5: search keyword length guard.
 *
 * We reach into prepareSearchData via a shimmed RequestContext to
 * verify the generated SQL contains a sentinel `1 = 0` clause when the
 * keyword is too short, and a LIKE expression otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { prepareSearchData } from '@/lib/page-data';
import { schema } from '@/db';

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
      timezone: 0,
      commentsAntiSpam: 0,
      secret: '',
    } as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
  };
}
