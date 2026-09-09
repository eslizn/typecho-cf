/**
 * Regression: preparePageData / preparePostData must treat an explicit
 * `null` preloadedRow as "looked up and not found" — returning 404 without
 * re-querying — while `undefined` still falls back to the helper's own
 * lookup. The old `preloadedRow ?? findFirst(...)` re-ran the identical
 * query for every missing page slug, doubling 404-path D1 reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { preparePageData, preparePostData } from '@/lib/page-data';

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      pageSize: 10,
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
    ...overrides,
  };
}

async function seedPage() {
  await testDb.insert(schema.users).values({
    name: 'alice', mail: 'alice@example.com', group: 'editor', authCode: 'x',
  });
  const author = (await testDb.query.users.findFirst())!;
  await testDb.insert(schema.contents).values({
    title: 'About', slug: 'about', type: 'page', status: 'publish', authorId: author.uid,
  });
  return (await testDb.query.contents.findFirst({
    where: (t, { eq }) => eq(t.slug, 'about'),
  }))!;
}

/** Wrap the DB so contents.findFirst calls are observable. */
function spyContentsFindFirst() {
  const findFirst = vi.fn((...args: any[]) =>
    (testDb.query.contents.findFirst as any)(...args),
  );
  const wrapped = {
    ...testDb,
    query: { ...testDb.query, contents: { ...testDb.query.contents, findFirst } },
  } as any;
  return { wrapped, findFirst };
}

describe('preloadedRow null vs undefined', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('preparePageData(null) returns 404 without re-querying', async () => {
    await seedPage();
    const { wrapped, findFirst } = spyContentsFindFirst();
    const result = await preparePageData(
      buildCtx({ db: wrapped }) as any,
      'missing',
      'https://example.com/missing.html',
      null,
      null,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('preparePageData(undefined) still performs its own lookup', async () => {
    await seedPage();
    const { wrapped, findFirst } = spyContentsFindFirst();
    const result = await preparePageData(
      buildCtx({ db: wrapped }) as any,
      'missing',
      'https://example.com/missing.html',
      null,
      undefined,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('preparePostData(null) returns 404 without re-querying', async () => {
    await seedPage();
    const { wrapped, findFirst } = spyContentsFindFirst();
    const result = await preparePostData(
      buildCtx({ db: wrapped }) as any,
      9999,
      'https://example.com/archives/9999/',
      null,
      null,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('preparePostData(undefined) still performs its own lookup', async () => {
    await seedPage();
    const { wrapped, findFirst } = spyContentsFindFirst();
    const result = await preparePostData(
      buildCtx({ db: wrapped }) as any,
      9999,
      'https://example.com/archives/9999/',
      null,
      undefined,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
