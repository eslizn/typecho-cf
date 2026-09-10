/**
 * Behavior test for the admin comment-list scope.
 *
 * Replaces the previous source-grep assertion that the page contains
 * `schema.contents.authorId`: the rule is now an executable query scope, so
 * the test runs it against a real database. Moderation rights must follow
 * `contents.authorId` (the current author) and never `comments.ownerId`
 * (a historical snapshot) — AGENTS.md §4.1.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';
import { schema } from '@/db';
import { commentModerationScope } from '@/lib/comment-moderation';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

/** Comments joined to their content, scoped exactly like the admin page. */
async function visibleCommentIds(viewer: { uid: number; group: string }, filters = {}) {
  const rows = await testDb
    .select({ coid: schema.comments.coid })
    .from(schema.comments)
    .leftJoin(schema.contents, eq(schema.comments.cid, schema.contents.cid))
    .where(commentModerationScope(viewer, filters));
  return rows.map((row) => row.coid);
}

async function seed() {
  testDb = await createTestDb();
  const [mine] = await testDb.insert(schema.contents).values({
    title: 'Mine', slug: 'mine', type: 'post', status: 'publish', created: 100, modified: 100, authorId: 7,
  }).returning({ cid: schema.contents.cid });
  const [theirs] = await testDb.insert(schema.contents).values({
    title: 'Theirs', slug: 'theirs', type: 'post', status: 'publish', created: 100, modified: 100, authorId: 8,
  }).returning({ cid: schema.contents.cid });

  const rows = await testDb.insert(schema.comments).values([
    { cid: mine.cid, created: 100, author: 'A', text: 'hello world', status: 'approved', ownerId: 7 },
    { cid: mine.cid, created: 101, author: 'B', text: 'second', status: 'approved', ownerId: 7 },
    { cid: mine.cid, created: 102, author: 'C', text: 'spam here', status: 'spam', ownerId: 7 },
    // Already reassigned to author 8, but the comment carries ownerId 7: the
    // stale snapshot must not grant user 7 visibility.
    { cid: theirs.cid, created: 103, author: 'D', text: 'foreign', status: 'approved', ownerId: 7 },
  ]).returning({ coid: schema.comments.coid, status: schema.comments.status, text: schema.comments.text });
  return rows;
}

describe('commentModerationScope', () => {
  it('shows an administrator every comment of the requested status', async () => {
    const rows = await seed();
    const approved = rows.filter((row) => row.status === 'approved').map((row) => row.coid);

    expect((await visibleCommentIds({ uid: 1, group: 'administrator' }, { status: 'approved' })).sort())
      .toEqual(approved.sort());
  });

  it('limits everyone else to comments on content they author', async () => {
    const rows = await seed();
    const mine = rows.filter((row) => row.text !== 'foreign' && row.status === 'approved').map((row) => row.coid);

    expect((await visibleCommentIds({ uid: 7, group: 'contributor' }, { status: 'approved' })).sort())
      .toEqual(mine.sort());
  });

  it('never widens scope through the comments.ownerId snapshot', async () => {
    await seed();
    const visible = await visibleCommentIds({ uid: 7, group: 'contributor' }, { status: 'approved' });

    expect(visible).toHaveLength(2);
  });

  it('applies keyword and cid filters inside the same scope', async () => {
    const rows = await seed();
    const world = rows.find((row) => row.text === 'hello world')!;

    expect(await visibleCommentIds({ uid: 7, group: 'contributor' }, { status: 'approved', keywords: 'hello' }))
      .toEqual([world.coid]);
    expect(await visibleCommentIds({ uid: 7, group: 'contributor' }, { status: 'approved', keywords: 'foreign' }))
      .toEqual([]);
  });
});
