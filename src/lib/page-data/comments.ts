import type { SiteOptions } from '@/lib/options';
import { DEFAULT_TIMEZONE } from '@/lib/timezone';
import { renderCommentTextFiltered } from '@/lib/markdown';
import { buildGravatarUrl } from '@/lib/gravatar';
import type { RequestContext } from '@/lib/context';
import { applyFilterSafely } from '@/lib/plugin';
import { getRequestI18n, type CommentRow } from './common';
import type { CommentNode, CommentOptions } from '@/lib/theme-props';

async function filterCommentRow(ctx: RequestContext, comment: CommentRow): Promise<CommentRow> {
  const filtered = await applyFilterSafely(ctx, 'comment:data', { ...comment }, {
    comment,
    capabilityRuntime: ctx.capabilityRuntime,
  });
  if (!filtered || typeof filtered !== 'object') return comment;
  const candidate = filtered as Record<string, unknown>;
  const display: Partial<CommentRow> = {};
  if (typeof candidate.author === 'string' || candidate.author === null) display.author = candidate.author;
  if (typeof candidate.mail === 'string' || candidate.mail === null) display.mail = candidate.mail;
  if (typeof candidate.url === 'string' || candidate.url === null) display.url = candidate.url;
  if (typeof candidate.text === 'string' || candidate.text === null) display.text = candidate.text;
  return {
    ...comment,
    ...display,
    // Keep comment identity, ownership, moderation and tree relationships intact.
    coid: comment.coid,
    cid: comment.cid,
    ownerId: comment.ownerId,
    parent: comment.parent,
    status: comment.status,
    created: comment.created,
  };
}

export async function buildCommentTree(
  ctx: RequestContext,
  allComments: CommentRow[],
  options: SiteOptions,
  replyLinks?: Record<number, string>,
): Promise<CommentNode[]> {
  const displayComments = await Promise.all(allComments.map(comment => filterCommentRow(ctx, comment)));
  const map = new Map<number, CommentNode>();
  const roots: CommentNode[] = [];

  // Render every body in parallel: the markdown pass plus the
  // comment:markdown / comment:rendered plugin filters used to run serially
  // inside this loop, so a 100-comment page paid the whole chain end to end.
  const renderedTexts = await Promise.all(displayComments.map((c) =>
    renderCommentTextFiltered(ctx, c.text || '', {
      markdown: !!options.commentsMarkdown,
      htmlTagAllowed: options.commentsHTMLTagAllowed,
    })
  ));

  displayComments.forEach((c, index) => {
    map.set(c.coid, {
      coid: c.coid,
      author: c.author || getRequestI18n(ctx).t('core.comment.anonymous', {}, 'Anonymous'),
      mail: c.mail || '',
      url: c.url || '',
      text: renderedTexts[index],
      created: c.created || 0,
      children: [],
      repliesUrl: replyLinks?.[c.coid],
    });
  });

  if (!options.commentsThreaded) {
    return displayComments.map(comment => map.get(comment.coid)!);
  }

  // Mirror Typecho's render-time nesting limit (Widget\Comments\Archive):
  // a comment at or beyond the configured depth is reattached to its
  // grandparent, so the displayed tree never nests deeper than the setting.
  // Submissions are not rejected; the limit is a presentation rule.
  const maxLevels = Math.max(1, Math.floor(Number(options.commentsMaxNestingLevels) || 5));
  const levels = new Map<number, number>();
  const parents = new Map<number, number>();

  for (const comment of [...displayComments].sort((a, b) => a.coid - b.coid)) {
    const originalParent = comment.parent || 0;
    const parentLevel = levels.get(originalParent);
    const parentKnown = originalParent > 0
      && parentLevel !== undefined
      && map.has(originalParent);

    let level = parentKnown ? parentLevel + 1 : 0;
    let parent = parentKnown ? originalParent : 0;
    if (parentKnown && level >= maxLevels) {
      level = parentLevel;
      parent = parents.get(originalParent) ?? 0;
    }
    levels.set(comment.coid, level);
    parents.set(comment.coid, parent);
  }

  for (const c of displayComments) {
    const node = map.get(c.coid)!;
    const parent = parents.get(c.coid) ?? 0;
    if (parent > 0 && parent !== c.coid && map.has(parent)) {
      map.get(parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function buildGravatarMap(allComments: CommentRow[], avatarRating: string): Promise<Record<number, string>> {
  const urlsByEmail = new Map<string, Promise<string>>();
  const entries = await Promise.all(
    allComments.map(async (c) => {
      const email = (c.mail || '').trim().toLowerCase();
      let pending = urlsByEmail.get(email);
      if (!pending) {
        pending = buildGravatarUrl(email, {
          defaultImage: 'identicon',
          size: 40,
          rating: avatarRating,
        });
        urlsByEmail.set(email, pending);
      }
      return [c.coid, await pending] as const;
    })
  );
  return Object.fromEntries(entries);
}

export function buildCommentOptions(options: SiteOptions, securityToken: string): CommentOptions {
  return {
    allowComment: true,
    requireMail: !!options.commentsRequireMail,
    showUrl: !!options.commentsShowUrl,
    showAvatar: !!options.commentsAvatar,
    avatarRating: options.commentsAvatarRating || 'G',
    order: options.commentsOrder === 'DESC' ? 'DESC' : 'ASC',
    dateFormat: options.commentDateFormat || 'Y-m-d H:i',
    timezone: options.timezone ?? DEFAULT_TIMEZONE,
    securityToken,
    showCommentOnly: !!options.commentsShowCommentOnly,
    markdown: !!options.commentsMarkdown,
    urlNofollow: !!options.commentsUrlNofollow,
    threaded: !!options.commentsThreaded,
    maxNestingLevels: Number(options.commentsMaxNestingLevels) || 5,
    pageBreak: !!options.commentsPageBreak,
    pageSize: Number(options.commentsPageSize) || 20,
    pageDisplay: (options.commentsPageDisplay === 'first' ? 'first' : 'last') as 'first' | 'last',
    htmlTagAllowed: options.commentsHTMLTagAllowed || '',
  };
}
