/**
 * G7-4 regression: canModerateComment / deleteSpamCommentsForUser must
 * use the live `contents.authorId` rather than the historical
 * `comments.ownerId` snapshot. Otherwise post-author transfers leave
 * the previous author retaining moderation power.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, type TestDatabase } from '../helpers';
import { applyCommentAction, applyCommentActions, canModerateComment, deleteSpamCommentsForUser } from '@/lib/comment-moderation';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDb();
});

async function seedUser(name: string, group: string) {
  const inserted = await testDb.insert(schema.users).values({
    name, mail: `${name}@example.com`, group, authCode: 'x',
  }).returning({ uid: schema.users.uid });
  return (await testDb.query.users.findFirst({
    where: (t, { eq }) => eq(t.uid, inserted[0].uid),
  }))!;
}

async function seedPost(authorId: number) {
  await testDb.insert(schema.contents).values({
    title: 'Post', slug: `post-${authorId}-${Math.random()}`,
    type: 'post', status: 'publish', authorId, created: 100,
  });
  return (await testDb.query.contents.findFirst({
    where: (t, { eq }) => eq(t.authorId, authorId),
  }))!;
}

async function seedComment(cid: number, ownerId: number, status: 'approved' | 'waiting' | 'spam' = 'approved') {
  await testDb.insert(schema.comments).values({
    cid, author: 'A', text: 'hi', status, type: 'comment', ownerId, created: 200,
  });
  return (await testDb.query.comments.findFirst({
    where: (t, { eq }) => eq(t.cid, cid),
  }))!;
}

describe('canModerateComment (G7-4)', () => {
  it('admins can moderate any comment', async () => {
    const admin = await seedUser('admin', 'administrator');
    const editor = await seedUser('editor', 'editor');
    const post = await seedPost(editor.uid);
    const comment = await seedComment(post.cid, editor.uid);

    expect(await canModerateComment(testDb as any, admin, comment)).toBe(true);
  });

  it('current owner of the post can moderate even if comment.ownerId is stale', async () => {
    // Post starts with editorOld, comment.ownerId records editorOld.
    const editorOld = await seedUser('old', 'editor');
    const editorNew = await seedUser('new', 'editor');
    const post = await seedPost(editorOld.uid);
    const comment = await seedComment(post.cid, editorOld.uid);

    // Reassign post to editorNew — comment.ownerId is unchanged.
    await testDb.update(schema.contents).set({ authorId: editorNew.uid })
      .where(eq(schema.contents.cid, post.cid));

    // editorNew should now be allowed (was not authorId of the post originally).
    expect(await canModerateComment(testDb as any, editorNew, comment)).toBe(true);
    // editorOld should NOT — ownerId on the comment is no longer the source of truth.
    expect(await canModerateComment(testDb as any, editorOld, comment)).toBe(false);
  });

  it('rejects comments with no cid', async () => {
    const editor = await seedUser('editor', 'editor');
    expect(await canModerateComment(testDb as any, editor, { cid: 0, status: 'approved' } as any)).toBe(false);
  });
});

describe('deleteSpamCommentsForUser (G7-4)', () => {
  it('non-admin only deletes spam attached to posts they currently own', async () => {
    const editorA = await seedUser('a', 'editor');
    const editorB = await seedUser('b', 'editor');
    const postA = await seedPost(editorA.uid);
    const postB = await seedPost(editorB.uid);
    await seedComment(postA.cid, editorA.uid, 'spam');
    await seedComment(postB.cid, editorB.uid, 'spam');

    const removed = await deleteSpamCommentsForUser(testDb as any, editorA);
    expect(removed).toBe(1);
    const remaining = await testDb.select().from(schema.comments);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].cid).toBe(postB.cid);
  });

  it('admin sweeps all spam regardless of ownership', async () => {
    const admin = await seedUser('admin', 'administrator');
    const editor = await seedUser('e', 'editor');
    const post = await seedPost(editor.uid);
    await seedComment(post.cid, editor.uid, 'spam');
    await seedComment(post.cid, editor.uid, 'spam');

    const removed = await deleteSpamCommentsForUser(testDb as any, admin);
    expect(removed).toBe(2);
    const remaining = await testDb.select().from(schema.comments);
    expect(remaining).toHaveLength(0);
  });

  it('returns 0 when the non-admin owns no posts', async () => {
    const stranger = await seedUser('s', 'editor');
    const owner = await seedUser('o', 'editor');
    const post = await seedPost(owner.uid);
    await seedComment(post.cid, owner.uid, 'spam');

    const removed = await deleteSpamCommentsForUser(testDb as any, stranger);
    expect(removed).toBe(0);
  });
});


describe('moderation counters with stale snapshots', () => {
  const ctx = { activatedPlugins: new Set<string>() };
  for (const mode of ['single', 'batch'] as const) {
    const apply = (comments: Array<typeof schema.comments.$inferSelect>, action: 'approved' | 'delete') =>
      mode === 'single'
        ? applyCommentAction(ctx, testDb as any, comments[0], action)
        : applyCommentActions(ctx, testDb as any, comments, action);

    it(`${mode}: repeated approval of a stale waiting snapshot counts once`, async () => {
      const user = await seedUser('moderator', 'administrator');
      const post = await seedPost(user.uid);
      const stale = await seedComment(post.cid, user.uid, 'waiting');
      await apply([stale], 'approved');
      await apply([stale], 'approved');
      expect((await testDb.query.contents.findFirst())?.commentsNum).toBe(1);
    });

    it(`${mode}: repeated deletion preserves another approved comment count`, async () => {
      const user = await seedUser('moderator', 'administrator');
      const post = await seedPost(user.uid);
      const stale = await seedComment(post.cid, user.uid);
      await testDb.insert(schema.comments).values({ cid: post.cid, status: 'approved', type: 'pingback' });
      await testDb.update(schema.contents).set({ commentsNum: 2 }).where(eq(schema.contents.cid, post.cid));
      await apply([stale], 'delete');
      await apply([stale], 'delete');
      expect((await testDb.query.contents.findFirst())?.commentsNum).toBe(1);
    });

    it(`${mode}: failure to update count rolls back the status change`, async () => {
      const user = await seedUser('moderator', 'administrator');
      const post = await seedPost(user.uid);
      const comment = await seedComment(post.cid, user.uid, 'waiting');
      await testDb.$client.execute(`CREATE TRIGGER reject_count_update BEFORE UPDATE OF commentsNum ON typecho_contents BEGIN SELECT RAISE(ABORT, 'count failure'); END`);
      await expect(apply([comment], 'approved')).rejects.toThrow();
      expect((await testDb.query.comments.findFirst())?.status).toBe('waiting');
      expect((await testDb.query.contents.findFirst())?.commentsNum).toBe(0);
    });
  }
});
