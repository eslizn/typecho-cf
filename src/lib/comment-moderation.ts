import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { hasPermission } from '@/lib/auth';
import { bumpCacheVersion, purgeContentCache } from '@/lib/cache';
import type { SiteOptions } from '@/lib/options';
import { doHook } from '@/lib/plugin';

export const COMMENT_ACTIONS = ['approve', 'approved', 'waiting', 'spam', 'delete'] as const;
export type CommentAction = typeof COMMENT_ACTIONS[number];

type CommentRow = typeof schema.comments.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

export function normalizeCommentAction(action: string): CommentAction | null {
  if (action === 'approve') return 'approved';
  return COMMENT_ACTIONS.includes(action as CommentAction) ? action as CommentAction : null;
}

/**
 * Check whether `user` may moderate `comment`.
 *
 * G7-4: the legacy implementation checked `comment.ownerId === user.uid`,
 * but ownerId is set at comment creation and never re-synced when a
 * post's author changes. We now ask the live `contents.authorId` so
 * permission tracks whoever currently owns the post.
 */
export async function canModerateComment(
  db: Database,
  user: UserRow,
  comment: CommentRow,
): Promise<boolean> {
  if (hasPermission(user.group || 'visitor', 'administrator')) return true;
  if (!comment.cid) return false;
  const owner = await db.query.contents.findFirst({
    columns: { authorId: true },
    where: eq(schema.contents.cid, comment.cid),
  });
  return !!owner && owner.authorId === user.uid;
}

export async function getModeratableComment(
  db: Database,
  coid: number,
  user: UserRow,
): Promise<CommentRow | Response> {
  const comment = await db.query.comments.findFirst({
    where: eq(schema.comments.coid, coid),
  });
  if (!comment) return new Response('Not Found', { status: 404 });
  if (!(await canModerateComment(db, user, comment))) return new Response('Forbidden', { status: 403 });
  return comment;
}

export async function applyCommentAction(
  db: Database,
  comment: CommentRow,
  action: CommentAction,
  options?: Record<string, unknown>,
): Promise<void> {
  const oldStatus = comment.status;

  if (action === 'delete') {
    await db.delete(schema.comments).where(eq(schema.comments.coid, comment.coid));
    if (oldStatus === 'approved') {
      await decrementCommentCount(db, comment.cid || 0);
    }
    await doHook('comment:action', comment, { action, oldStatus, newStatus: 'deleted', options });
    return;
  }

  const nextStatus = action === 'approved' ? 'approved' : action;
  await db.update(schema.comments)
    .set({ status: nextStatus })
    .where(eq(schema.comments.coid, comment.coid));

  if (oldStatus !== 'approved' && nextStatus === 'approved') {
    await incrementCommentCount(db, comment.cid || 0);
  } else if (oldStatus === 'approved' && nextStatus !== 'approved') {
    await decrementCommentCount(db, comment.cid || 0);
  }

  await doHook('comment:action', comment, { action, oldStatus, newStatus: nextStatus, options });
}

export async function deleteSpamCommentsForUser(
  db: Database,
  user: UserRow,
): Promise<number> {
  const isAdmin = hasPermission(user.group || 'visitor', 'administrator');
  if (isAdmin) {
    const before = await db
      .select({ coid: schema.comments.coid })
      .from(schema.comments)
      .where(eq(schema.comments.status, 'spam'));
    if (before.length === 0) return 0;
    await db.delete(schema.comments).where(eq(schema.comments.status, 'spam'));
    return before.length;
  }

  // Non-admin: clear spam attached to posts the user currently owns.
  // G7-4: use the live contents.authorId rather than the historical
  // comment.ownerId.
  const ownedCids = await db
    .select({ cid: schema.contents.cid })
    .from(schema.contents)
    .where(eq(schema.contents.authorId, user.uid));
  if (ownedCids.length === 0) return 0;

  const cidIn = sql.join(ownedCids.map(o => sql`${o.cid}`), sql`, `);
  const before = await db
    .select({ coid: schema.comments.coid })
    .from(schema.comments)
    .where(and(
      eq(schema.comments.status, 'spam'),
      sql`${schema.comments.cid} IN (${cidIn})`,
    ));
  if (before.length === 0) return 0;
  await db.delete(schema.comments).where(and(
    eq(schema.comments.status, 'spam'),
    sql`${schema.comments.cid} IN (${cidIn})`,
  ));
  return before.length;
}

export async function purgeCommentModerationCache(
  db: Database,
  options: SiteOptions,
  cid?: number | null,
): Promise<void> {
  await bumpCacheVersion(db);
  await purgeContentCache(options.siteUrl || '', cid || undefined);
}

async function incrementCommentCount(db: Database, cid: number): Promise<void> {
  if (!cid) return;
  await db.update(schema.contents)
    .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
    .where(eq(schema.contents.cid, cid));
}

async function decrementCommentCount(db: Database, cid: number): Promise<void> {
  if (!cid) return;
  await db.update(schema.contents)
    .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
    .where(eq(schema.contents.cid, cid));
}
