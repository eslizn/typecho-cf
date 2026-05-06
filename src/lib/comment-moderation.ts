import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { hasPermission } from '@/lib/auth';
import { bumpCacheVersion, purgeContentCache } from '@/lib/cache';
import type { SiteOptions } from '@/lib/options';

export const COMMENT_ACTIONS = ['approve', 'approved', 'waiting', 'spam', 'delete'] as const;
export type CommentAction = typeof COMMENT_ACTIONS[number];

type CommentRow = typeof schema.comments.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

export function normalizeCommentAction(action: string): CommentAction | null {
  if (action === 'approve') return 'approved';
  return COMMENT_ACTIONS.includes(action as CommentAction) ? action as CommentAction : null;
}

export function canModerateComment(user: UserRow, comment: CommentRow): boolean {
  return hasPermission(user.group || 'visitor', 'administrator') || comment.ownerId === user.uid;
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
  if (!canModerateComment(user, comment)) return new Response('Forbidden', { status: 403 });
  return comment;
}

export async function applyCommentAction(
  db: Database,
  comment: CommentRow,
  action: CommentAction,
): Promise<void> {
  const oldStatus = comment.status;

  if (action === 'delete') {
    await db.delete(schema.comments).where(eq(schema.comments.coid, comment.coid));
    if (oldStatus === 'approved') {
      await decrementCommentCount(db, comment.cid || 0);
    }
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
}

export async function deleteSpamCommentsForUser(
  db: Database,
  user: UserRow,
): Promise<number> {
  const isAdmin = hasPermission(user.group || 'visitor', 'administrator');
  const spamComments = await db
    .select({ coid: schema.comments.coid })
    .from(schema.comments)
    .where(isAdmin
      ? eq(schema.comments.status, 'spam')
      : and(eq(schema.comments.status, 'spam'), eq(schema.comments.ownerId, user.uid))
    );

  for (const comment of spamComments) {
    await db.delete(schema.comments).where(eq(schema.comments.coid, comment.coid));
  }
  return spamComments.length;
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
