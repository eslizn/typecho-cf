import { eq, and, desc, asc, lt, gt } from 'drizzle-orm';
import { schema } from '@/db';
import { buildPermalink, buildCategoryLink, buildTagLink } from '@/lib/content';
import { renderMarkdownFiltered } from '@/lib/markdown';
import { generateCommentToken, timeSafeEqual } from '@/lib/auth';
import { loadCommentPage } from '@/lib/comment-page';
import type { RequestContext } from '@/lib/context';
import { doHook } from '@/lib/plugin';
import { canViewContent, publishedPostCondition } from '@/lib/content-visibility';
import { escapeHtml } from '@/lib/escape';
import type { ThemePostProps, ThemePageProps } from '@/lib/theme-props';
import { buildCommentOptions, buildCommentTree, buildGravatarMap } from './comments';
import {
  filterContentRow,
  filterContentTitle,
  getRequestI18n,
  loadCommon,
  type ContentRow,
  type ContentTermEntry,
} from './common';

// ─── Post detail ────────────────────────────────────────────────────────

export interface PreparePostResult {
  props: ThemePostProps;
  /** If set, the page route should return this Response instead */
  redirect?: never;
}

/**
 * Optional overrides for authenticated single-content previews.
 *
 * `allowPreview` is intentionally an explicit opt-in: the normal public
 * content routes must continue enforcing draft/private visibility. Preview
 * callers are responsible for authenticating and authorizing the request
 * before using this flag.
 */
export interface SingleContentOptions {
  allowPreview?: boolean;
  permalink?: string;
  categories?: ContentTermEntry[];
  tags?: ContentTermEntry[];
}

export async function preparePostData(
  ctx: RequestContext,
  cidNum: number,
  requestUrl: string,
  suppliedPassword: string | null,
  preloadedRow?: ContentRow | null,
  singleOptions: SingleContentOptions = {},
): Promise<ThemePostProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const contentRow = preloadedRow !== undefined
    ? preloadedRow
    : await db.query.contents.findFirst({
        where: eq(schema.contents.cid, cidNum),
      });

  if (!contentRow) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  if (!singleOptions.allowPreview && !canViewContent(contentRow, { isLoggedIn, uid: user?.uid })) {
    return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });
  }

  const singleLifecycle = {
    archiveType: 'single',
    requestUrl,
    path: new URL(requestUrl).pathname,
    params: { cid: contentRow.cid, type: contentRow.type || 'post' },
    options,
    urls,
    user,
    capabilityRuntime: ctx.capabilityRuntime,
  };
  await doHook(ctx, 'archive:init', singleLifecycle);
  await doHook(ctx, 'archive:single', singleLifecycle);

  const displayContentRow = await filterContentRow(ctx, contentRow, 'single');
  const displayTitle = await filterContentTitle(
    ctx,
    displayContentRow.title || getRequestI18n(ctx).t('core.content.untitled', {}, 'Untitled'),
    displayContentRow,
  );

  // Password
  const hasPassword = !!contentRow.password;
  const passwordVerified = hasPassword
    && !!suppliedPassword
    && timeSafeEqual(suppliedPassword, contentRow.password as string);

  // Keep all content-specific reads in one D1 round trip while the common
  // chrome data loads independently.
  const [
    common,
    [
      authorRows,
      relatedMetas,
      prevPostRows,
      nextPostRows,
    ],
    commentPage,
  ] = await Promise.all([
    loadCommon(ctx, requestUrl),
    db.batch([
      db
        .select({
          uid: schema.users.uid,
          name: schema.users.name,
          screenName: schema.users.screenName,
        })
        .from(schema.users)
        .where(eq(schema.users.uid, contentRow.authorId || 0))
        .limit(1),
      db
        .select({ name: schema.metas.name, slug: schema.metas.slug, type: schema.metas.type })
        .from(schema.relationships)
        .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
        .where(eq(schema.relationships.cid, cidNum)),
      db
        .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
        .from(schema.contents)
        .where(and(publishedPostCondition(), lt(schema.contents.created, contentRow.created || 0)))
        .orderBy(desc(schema.contents.created))
        .limit(1),
      db
        .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
        .from(schema.contents)
        .where(and(publishedPostCondition(), gt(schema.contents.created, contentRow.created || 0)))
        .orderBy(asc(schema.contents.created))
        .limit(1),
    ]),
    loadCommentPage(db, cidNum, options, requestUrl, contentRow.commentsNum ?? null, options.cacheVersion),
  ]);
  const author = authorRows[0] ?? null;
  const allComments = commentPage.rows;

  type MetaEntry = { name: string | null; slug: string | null; type: string | null };
  const categories = singleOptions.categories ?? (relatedMetas as MetaEntry[]).filter(m => m.type === 'category').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildCategoryLink(m.slug || '', urls.siteUrl, options.categoryPattern as string | undefined),
  }));
  const tags = singleOptions.tags ?? (relatedMetas as MetaEntry[]).filter(m => m.type === 'tag').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildTagLink(m.slug || '', urls.siteUrl),
  }));

  const commentTree = await buildCommentTree(ctx, allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};

  const permalink = singleOptions.permalink ?? buildPermalink(
    { cid: contentRow.cid, slug: contentRow.slug, type: contentRow.type, created: contentRow.created, category: categories[0]?.slug },
    urls.siteUrl,
    options.permalinkPattern as string | undefined,
  );

  const allowComment = contentRow.allowComment === '1';
  const renderedContent = hasPassword && !passwordVerified
    ? `<p>${escapeHtml(getRequestI18n(ctx).t('core.content.passwordProtected', {}, 'This content is password protected. Enter the password to view it.'))}</p>`
    : await renderMarkdownFiltered(ctx, displayContentRow.text || '');

  // Generate CSRF token for comment form, bound to cid so that pages
  // visited via email/RSS without a referer still validate.
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, contentRow.cid)
    : '';

  return {
    ...common,
    post: {
      cid: contentRow.cid,
      title: displayTitle,
      permalink,
      content: renderedContent,
      created: contentRow.created || 0,
      modified: contentRow.modified,
      commentsNum: contentRow.commentsNum || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    author: author ? { uid: author.uid, name: author.name || '', screenName: author.screenName || author.name || '' } : null,
    categories,
    tags,
    comments: commentTree,
    commentPagination: commentPage.pagination,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    prevPost: prevPostRows[0] ? {
      title: prevPostRows[0].title || getRequestI18n(ctx).t('core.content.untitled', {}, 'Untitled'),
      permalink: buildPermalink(prevPostRows[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    nextPost: nextPostRows[0] ? {
      title: nextPostRows[0].title || getRequestI18n(ctx).t('core.content.untitled', {}, 'Untitled'),
      permalink: buildPermalink(nextPostRows[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    gravatarMap,
  };
}

// ─── Independent page ───────────────────────────────────────────────────

export async function preparePageData(
  ctx: RequestContext,
  cleanSlug: string,
  requestUrl: string,
  suppliedPassword: string | null,
  preloadedRow?: ContentRow | null,
  singleOptions: SingleContentOptions = {},
): Promise<ThemePageProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const pageRow = preloadedRow !== undefined
    ? preloadedRow
    : await db.query.contents.findFirst({
        where: and(eq(schema.contents.slug, cleanSlug), eq(schema.contents.type, 'page')),
      });

  if (!pageRow) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  if (!singleOptions.allowPreview && !canViewContent(pageRow, { isLoggedIn, uid: user?.uid })) {
    return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });
  }

  const singleLifecycle = {
    archiveType: 'single',
    requestUrl,
    path: new URL(requestUrl).pathname,
    params: { cid: pageRow.cid, slug: cleanSlug, type: 'page' },
    options,
    urls,
    user,
    capabilityRuntime: ctx.capabilityRuntime,
  };
  await doHook(ctx, 'archive:init', singleLifecycle);
  await doHook(ctx, 'archive:single', singleLifecycle);

  const displayPageRow = await filterContentRow(ctx, pageRow, 'single');
  const displayTitle = await filterContentTitle(
    ctx,
    displayPageRow.title || getRequestI18n(ctx).t('core.content.untitled', {}, 'Untitled'),
    displayPageRow,
  );

  const permalink = singleOptions.permalink ?? buildPermalink(
    { cid: pageRow.cid, slug: pageRow.slug, type: pageRow.type, created: pageRow.created },
    urls.siteUrl,
    undefined,
    options.pagePattern as string | undefined,
  );

  const hasPassword = !!pageRow.password;
  const passwordVerified = hasPassword
    && !!suppliedPassword
    && timeSafeEqual(suppliedPassword, pageRow.password as string);

  const [commentPage, common] = await Promise.all([
    loadCommentPage(db, pageRow.cid, options, requestUrl, pageRow.commentsNum ?? null, options.cacheVersion),
    loadCommon(ctx, requestUrl),
  ]);
  const allComments = commentPage.rows;

  const commentTree = await buildCommentTree(ctx, allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};
  const allowComment = pageRow.allowComment === '1';

  const renderedContent = hasPassword && !passwordVerified
    ? `<p>${escapeHtml(getRequestI18n(ctx).t('core.content.passwordProtected', {}, 'This content is password protected. Enter the password to view it.'))}</p>`
    : await renderMarkdownFiltered(ctx, displayPageRow.text || '');

  // Generate CSRF token for comment form, bound to cid so that pages
  // visited via email/RSS without a referer still validate.
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, pageRow.cid)
    : '';

  return {
    ...common,
    page: {
      cid: pageRow.cid,
      title: displayTitle,
      slug: cleanSlug,
      permalink,
      content: renderedContent,
      created: pageRow.created || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    comments: commentTree,
    commentPagination: commentPage.pagination,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    gravatarMap,
  };
}
