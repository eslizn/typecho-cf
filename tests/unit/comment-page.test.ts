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
