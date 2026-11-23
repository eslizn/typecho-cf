import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { loadCommentPage, resetCommentRootCountCache } from '@/lib/comment-page';
import type { SiteOptions } from '@/lib/options';

let db: TestDatabase;

const options = (overrides: Partial<SiteOptions> = {}) => ({
  commentsPageBreak: 1,
  commentsThreaded: 1,
  commentsPageSize: 2,
  commentsPageDisplay: 'first',
  commentsOrder: 'ASC',
  ...overrides,
} as SiteOptions);

beforeEach(async () => {
  db = await createTestDb();
  resetCommentRootCountCache();
});

afterEach(async () => {
  await disposeTestDb(db);
});

async function addComment(created: number, parent = 0) {
  const [row] = await db.insert(schema.comments).values({
    cid: 1,
    created,
    parent,
    author: `user-${created}`,
    text: `comment-${created}`,
    status: 'approved',
  }).returning();
  return row;
}

describe('loadCommentPage', () => {
  it('evicts old root counts when more than 200 fresh entries are written', async () => {
    const batch = vi.spyOn(db, 'batch');
    for (let cid = 1; cid <= 201; cid++) {
      await loadCommentPage(db as any, cid, options(), 'https://example.com/post', 0);
    }
    batch.mockClear();
    await loadCommentPage(db as any, 1, options(), 'https://example.com/post', 0);
    expect(batch).toHaveBeenCalledOnce();
    batch.mockRestore();
  });

  it('keeps the legacy full result when pagination is disabled', async () => {
    await addComment(1);
    await addComment(2);
    await addComment(3);

    const page = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageBreak: 0 }),
      'https://example.com/post',
    );

    expect(page.rows.map(row => row.created)).toEqual([1, 2, 3]);
    expect(page.pagination.enabled).toBe(false);
    expect(page.pagination.totalComments).toBe(3);
  });

  it('paginates flat comments without overlap and preserves the global count', async () => {
    for (let created = 1; created <= 5; created++) await addComment(created);

    const first = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=1',
    );
    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=2',
    );

    expect(first.rows.map(row => row.created)).toEqual([1, 2]);
    expect(second.rows.map(row => row.created)).toEqual([3, 4]);
    expect(second.pagination.totalComments).toBe(5);
    expect(second.pagination.totalPages).toBe(3);
  });

  it('paginates threaded comments by root and keeps descendants together', async () => {
    const rootOne = await addComment(1);
    await addComment(2, rootOne.coid);
    const rootTwo = await addComment(3);
    await addComment(4, rootTwo.coid);

    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=2',
    );

    expect(second.rows.map(row => row.coid)).toEqual([rootTwo.coid, rootTwo.coid + 1]);
    expect(second.rows.some(row => row.coid === rootOne.coid)).toBe(false);
    expect(second.pagination.totalComments).toBe(4);
    expect(second.pagination.totalPages).toBe(2);
  });

  it('treats approved replies with a missing or unapproved parent as roots', async () => {
    const waitingParent = await db.insert(schema.comments).values({
      cid: 1,
      created: 1,
      parent: 0,
      author: 'waiting-parent',
      text: 'waiting',
      status: 'waiting',
    }).returning();
    const orphanedByModeration = await addComment(2, waitingParent[0].coid);
    const preservedDescendant = await addComment(3, orphanedByModeration.coid);
    const missingParent = await addComment(4, 999_999);

    const first = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=1',
    );
    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=2',
    );

    expect(first.rows.map(row => row.coid)).toEqual([
      orphanedByModeration.coid,
      preservedDescendant.coid,
    ]);
    expect(second.rows.map(row => row.coid)).toEqual([missingParent.coid]);
    expect(first.pagination.totalComments).toBe(3);
    expect(first.pagination.totalPages).toBe(2);
  });

  it('uses the last page by default and clamps invalid pages', async () => {
    for (let created = 1; created <= 5; created++) await addComment(created);

    const last = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0, commentsPageDisplay: 'last' }),
      'https://example.com/post',
    );
    const clamped = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=999',
    );

    expect(last.pagination.currentPage).toBe(3);
    expect(last.rows.map(row => row.created)).toEqual([5]);
    expect(clamped.pagination.currentPage).toBe(3);
  });

  it('links to the first page when the last page is the default', async () => {
    for (let created = 1; created <= 5; created++) await addComment(created);
    const settings = options({ commentsPageDisplay: 'last' });
    const last = await loadCommentPage(db as any, 1, settings, 'https://example.com/post', 5);
    const first = await loadCommentPage(db as any, 1, settings, last.pagination.pageUrls[1], 5);
    expect(last.pagination.currentPage).toBe(3);
    expect(first.pagination.currentPage).toBe(1);
    expect(first.rows.map(row => row.created)).toEqual([1, 2]);
  });

  it('bounds a long thread preview and pages through all approved replies in order', async () => {
    const root = await addComment(1);
    for (let i = 2; i <= 17; i++) await addComment(i, root.coid);
    const branch = await addComment(18, 17);
    await db.insert(schema.comments).values({ cid: 1, parent: root.coid, status: 'waiting' });

    const settings = options({ commentsPageSize: 7 });
    const preview = await loadCommentPage(db as any, 1, settings, 'https://example.com/post?commentPage=1', 18);
    expect(preview.rows).toHaveLength(8);
    const first = await loadCommentPage(db as any, 1, settings, preview.replyLinks![root.coid], 18);
    const second = await loadCommentPage(db as any, 1, settings, first.pagination.replyPage!.nextUrl!, 18);
    const third = await loadCommentPage(db as any, 1, settings, second.pagination.replyPage!.nextUrl!, 18);
    expect([first, second, third].flatMap(page => page.rows.slice(1).map(row => row.created)))
      .toEqual(Array.from({ length: 16 }, (_, i) => i + 2));
    expect(third.pagination.replyPage?.nextUrl).toBeNull();
    expect(third.pagination.replyPage?.backUrl).toBe('https://example.com/post?commentPage=1#comments');
    const nested = await loadCommentPage(db as any, 1, settings, third.replyLinks![17], 18);
    expect(nested.rows.map(row => row.coid)).toEqual([17, branch.coid]);
    expect(nested.rows.every(row => row.status === 'approved')).toBe(true);
  });

  it('opens the configured last reply page by default and links back to the first', async () => {
    const root = await addComment(1);
    for (let created = 2; created <= 6; created++) await addComment(created, root.coid);
    const settings = options({ commentsPageDisplay: 'last', commentsPageSize: 3, commentsOrder: 'DESC' });
    const url = 'https://example.com/post?commentThread=1';
    const last = await loadCommentPage(db as any, 1, settings, url, 6);
    expect(last.pagination.replyPage?.currentPage).toBe(2);
    expect(last.rows.slice(1).map(row => row.created)).toEqual([3, 2]);
    const prevUrl = last.pagination.replyPage!.prevUrl!;
    expect(new URL(prevUrl).searchParams.get('replyPage')).toBe('1');
    const first = await loadCommentPage(db as any, 1, settings, prevUrl, 6);
    expect(first.rows.slice(1).map(row => row.created)).toEqual([6, 5, 4]);
    const clamped = await loadCommentPage(db as any, 1, settings, url + '&replyPage=999', 6);
    expect(clamped.pagination.replyPage?.currentPage).toBe(2);
  });

  it('ignores old reply page links when pagination is disabled and all comments fit', async () => {
    const root = await addComment(1);
    for (let created = 2; created <= 6; created++) await addComment(created, root.coid);
    const page = await loadCommentPage(db as any, 1, options({ commentsPageBreak: 0, commentsPageSize: 2 }),
      'https://example.com/post?commentThread=1&replyPage=2', 6);
    expect(page.rows.map(row => row.created)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(page.pagination.enabled).toBe(false);
    expect(page.pagination.replyPage).toBeUndefined();
    expect(page.replyLinks).toBeUndefined();
  });

  it.each([0, 1])('loads every approved comment with pagination off and threading set to %s', async (commentsThreaded) => {
    const root = await addComment(1);
    for (let start = 0; start < 200; start += 50) {
      await db.insert(schema.comments).values(Array.from({ length: 50 }, (_, index) => ({
        cid: 1, parent: root.coid, created: start + index + 2,
      })));
    }
    await db.insert(schema.comments).values([
      { cid: 1, parent: root.coid, created: 202, status: 'waiting' },
      { cid: 2, created: 203, status: 'approved' },
    ]);
    const settings = options({ commentsPageBreak: 0, commentsPageSize: 5, commentsThreaded });
    const page = await loadCommentPage(db as any, 1, settings,
      'https://example.com/post?commentPage=2&commentThread=1&replyPage=2', 201);
    expect(page.rows.map(row => row.created)).toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
    expect(page.pagination).toMatchObject({ enabled: false, currentPage: 1, totalPages: 1, totalComments: 201 });
    expect(page.pagination.replyPage).toBeUndefined();
    expect(page.replyLinks).toBeUndefined();
  });

  it('keeps every selected root when the thread preview reaches its global row budget', async () => {
    const roots = await db.insert(schema.comments).values(
      Array.from({ length: 50 }, (_, i) => ({ cid: 1, created: i + 1 })),
    ).returning();
    for (const root of roots) {
      await db.insert(schema.comments).values(
        Array.from({ length: 5 }, (_, i) => ({ cid: 1, parent: root.coid, created: 51 + i })),
      );
    }
    const page = await loadCommentPage(db as any, 1, options({ commentsPageSize: 50 }), 'https://example.com/post', 300);
    expect(page.rows).toHaveLength(200);
    expect(page.rows.filter(row => row.parent === 0).map(row => row.coid)).toEqual(roots.map(root => root.coid));
    expect(Object.keys(page.replyLinks!)).toHaveLength(20);
  });

  it('uses contents.commentsNum instead of a count(*) scan when provided', async () => {
    await db.insert(schema.contents).values({
      cid: 1,
      title: 'Post',
      slug: 'post',
      type: 'post',
      status: 'publish',
      commentsNum: 4,
    });
    for (let created = 1; created <= 4; created++) await addComment(created);

    const first = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=1',
      4,
      7,
    );
    const second = await loadCommentPage(
      db as any,
      1,
      options({ commentsThreaded: 0 }),
      'https://example.com/post?commentPage=2',
      4,
      7,
    );

    expect(first.rows.map(row => row.created)).toEqual([1, 2]);
    expect(second.rows.map(row => row.created)).toEqual([3, 4]);
    expect(first.pagination.totalComments).toBe(4);
    expect(first.pagination.totalPages).toBe(2);
  });

  it('caches the threaded root count per cacheVersion', async () => {
    const rootOne = await addComment(1);
    await addComment(2, rootOne.coid);

    const first = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=1',
      null,
      42,
    );
    const sameVersion = await loadCommentPage(
      db as any,
      1,
      options({ commentsPageSize: 1 }),
      'https://example.com/post?commentPage=2',
      null,
      42,
    );

    expect(first.pagination.totalPages).toBe(1);
    expect(sameVersion.pagination.totalPages).toBe(1);
  });

  it('recounts the threaded root total after the cache TTL expires', async () => {
    const rootOne = await addComment(1);
    await addComment(2, rootOne.coid);
    const batchSpy = vi.spyOn(db, 'batch');
    // Fake only Date so the in-memory DB's promise scheduling is untouched.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await loadCommentPage(
        db as any,
        1,
        options({ commentsPageSize: 1 }),
        'https://example.com/post?commentPage=1',
        null,
        42,
      );
      expect(batchSpy).toHaveBeenCalledTimes(1);
      // Miss: one batch with both the total and the root count queries.
      expect(batchSpy.mock.calls[0][0]).toHaveLength(2);
      batchSpy.mockClear();

      // Within the TTL the root count is served from cache — only the total
      // count query (commentsNum is absent in this test) still runs.
      await loadCommentPage(
        db as any,
        1,
        options({ commentsPageSize: 1 }),
        'https://example.com/post?commentPage=2',
        null,
        42,
      );
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy.mock.calls[0][0]).toHaveLength(1);
      batchSpy.mockClear();

      // After the TTL the root count is recomputed — both queries again.
      vi.advanceTimersByTime(60_001);
      await loadCommentPage(
        db as any,
        1,
        options({ commentsPageSize: 1 }),
        'https://example.com/post?commentPage=3',
        null,
        42,
      );
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy.mock.calls[0][0]).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      batchSpy.mockRestore();
    }
  });
});
