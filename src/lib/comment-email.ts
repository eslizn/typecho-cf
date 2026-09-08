/**
 * Comment email notification logic.
 *
 * Triggered after a comment is saved and approved. Sends two emails
 * (best-effort, via waitUntil): one to the post author, one to the
 * parent comment author (if applicable).
 */

import type { Database } from '@/db';
import { schema } from '@/db';
import { sendMail, isValidEmail, createMailI18n, type MailResult } from '@/lib/mail';
import type { HookContext } from '@/lib/plugin';
import { buildPermalink } from '@/lib/content';
import { escapeHtml } from '@/lib/escape';
import { eq } from 'drizzle-orm';

export interface NotifyCommentConfig {
  pluginCtx: HookContext;
  db: Database;
  options: Record<string, unknown>;
  siteUrl: string;
  permalinkPattern?: string;
  pagePattern?: string;
  comment: {
    coid: number;
    cid: number;
    author: string | null;
    mail: string | null;
    text: string | null;
    parent: number;
    authorId?: number | null;
  };
  content: {
    cid: number;
    title: string | null;
    slug: string | null;
    type: string;
    created: number;
    authorId: number | null;
  };
  request?: Request;
}

export async function notifyOnComment(cfg: NotifyCommentConfig): Promise<void> {
  if (!cfg.options.commentEmailEnabled) return;

  const i18n = createMailI18n(cfg.options, cfg.pluginCtx.activatedPlugins);
  const siteTitle = String(cfg.options.title || 'Typecho');
  const contentTitle = cfg.content.title || i18n.t('mail.untitled', {}, 'Untitled');
  const commentAuthor = cfg.comment.author || i18n.t('mail.anonymous', {}, 'Anonymous');

  const url = buildPermalink(cfg.content, cfg.siteUrl, cfg.permalinkPattern, cfg.pagePattern);
  const commentUrl = `${url}#comment-${cfg.comment.coid}`;

  const author = cfg.content.authorId
    ? await cfg.db.query.users.findFirst({
        where: eq(schema.users.uid, cfg.content.authorId),
        columns: { uid: true, mail: true, screenName: true, name: true },
      })
    : null;

  const promises: Promise<MailResult>[] = [];
  const sentTo = new Set<string>();

  // Notify post author
  if (
    author?.mail &&
    isValidEmail(author.mail) &&
    author.uid !== (cfg.comment.authorId || 0)
  ) {
    sentTo.add(author.mail);
    promises.push(
      sendMail(
        cfg.pluginCtx,
        {
          to: author.mail,
          subject: i18n.t('mail.comment.subject', { siteTitle, contentTitle }, `[${siteTitle}] New comment on "${contentTitle}"`),
          html: `<p>${escapeHtml(i18n.t('mail.comment.intro', { commentAuthor, contentTitle }, `${commentAuthor} commented on your post "${contentTitle}":`))}</p><blockquote>${escapeHtml(cfg.comment.text || '')}</blockquote><p><a href="${commentUrl}">${escapeHtml(i18n.t('mail.comment.view', {}, 'View comment'))}</a></p>`,
          text: `${i18n.t('mail.comment.intro', { commentAuthor, contentTitle }, `${commentAuthor} commented on your post "${contentTitle}":`)}\n\n${cfg.comment.text || ''}\n\n${i18n.t('mail.comment.view', {}, 'View comment')}: ${commentUrl}`,
        },
        { request: cfg.request, options: cfg.options, reason: 'comment', i18n },
      ),
    );
  }

  // Notify parent comment author (reply notification)
  if (cfg.comment.parent && cfg.options.commentEmailReplyEnabled !== false) {
    const parent = await cfg.db.query.comments.findFirst({
      where: eq(schema.comments.coid, cfg.comment.parent),
      columns: { mail: true, author: true },
    });
    if (
      parent?.mail &&
      isValidEmail(parent.mail) &&
      parent.mail !== cfg.comment.mail &&
      !sentTo.has(parent.mail)
    ) {
      promises.push(
        sendMail(
          cfg.pluginCtx,
          {
            to: parent.mail,
            subject: i18n.t('mail.comment.replySubject', { siteTitle, contentTitle }, `[${siteTitle}] New reply to your comment`),
            html: `<p>${escapeHtml(i18n.t('mail.comment.replyIntro', { commentAuthor, contentTitle }, `${commentAuthor} replied to your comment on "${contentTitle}":`))}</p><blockquote>${escapeHtml(cfg.comment.text || '')}</blockquote><p><a href="${commentUrl}">${escapeHtml(i18n.t('mail.comment.view', {}, 'View reply'))}</a></p>`,
            text: `${i18n.t('mail.comment.replyIntro', { commentAuthor, contentTitle }, `${commentAuthor} replied to your comment on "${contentTitle}":`)}\n\n${cfg.comment.text || ''}\n\n${i18n.t('mail.comment.view', {}, 'View reply')}: ${commentUrl}`,
          },
          { request: cfg.request, options: cfg.options, reason: 'comment-reply', i18n },
        ),
      );
    }
  }

  await Promise.allSettled(promises);
}
