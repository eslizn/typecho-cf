/**
 * Page data preparation layer
 *
 * Extracts DB queries from .astro page files into pure TypeScript functions.
 * Each function returns a standardized Props object for theme components.
 * This separation allows theme components to be purely presentational.
 */
import { eq, and, desc, asc, lt, gt, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { loadSidebarData, loadNavPages } from '@/lib/sidebar';
import {
  buildPermalink, buildAuthorLink,
  buildCategoryLink, buildTagLink, buildSearchLink,
} from '@/lib/content';
import { renderContentExcerpt, renderMarkdown, renderMarkdownFiltered } from '@/lib/markdown';
import { paginate } from '@/lib/pagination';
import { generateCommentToken } from '@/lib/auth';
import type { RequestContext } from '@/lib/context';
import type {
  ThemeIndexProps, ThemePostProps, ThemePageProps, ThemeArchiveProps, ThemeNotFoundProps,
  PostListItem, CommentNode, CommentOptions,
} from '@/lib/theme-props';

// ─── Local row types (derived from Drizzle schema) ───────────────────────

type ContentRow = typeof schema.contents.$inferSelect;
type CommentRow = typeof schema.comments.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

type CategoryEntry = { name: string; slug: string; permalink: string };
type CategoryMap = Map<number, CategoryEntry[]>;
type AuthorMap = Map<number, UserRow>;

// ─── Helpers ────────────────────────────────────────────────────────────

async function loadCommon(ctx: RequestContext, requestUrl: string) {
  const { db, options, urls, user, isLoggedIn } = ctx;
  const [sidebarData, pages] = await Promise.all([
    loadSidebarData(db, urls.siteUrl, options.permalinkPattern as string | undefined, options.categoryPattern as string | undefined),
    loadNavPages(db, urls.siteUrl, options.pagePattern as string | undefined),
  ]);
  const currentPath = new URL(requestUrl).pathname;
  return { options, urls, user, isLoggedIn, pages, sidebarData, currentPath };
}

function getPage(locals: Record<string, unknown>, url: URL): number {
  const pageParam = (locals._page as number | undefined) ?? url.searchParams.get('page');
  return pageParam ? (typeof pageParam === 'number' ? pageParam : parseInt(pageParam, 10) || 1) : 1;
}

async function sha256hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildCommentTree(allComments: CommentRow[]): CommentNode[] {
  const map = new Map<number, CommentNode>();
  const roots: CommentNode[] = [];

  for (const c of allComments) {
    map.set(c.coid, {
      coid: c.coid,
      author: c.author || '匿名',
      mail: c.mail || '',
      url: c.url || '',
      text: renderMarkdown(c.text || ''),
      created: c.created || 0,
      children: [],
    });
  }

  for (const c of allComments) {
    const node = map.get(c.coid)!;
    if (c.parent && map.has(c.parent)) {
      map.get(c.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

async function buildGravatarMap(allComments: CommentRow[], avatarRating: string): Promise<Record<number, string>> {
  const entries = await Promise.all(
    allComments.map(async (c) => {
      const hash = c.mail ? await sha256hex(c.mail) : '';
      return [c.coid, `https://gravatar.com/avatar/${hash}?d=identicon&s=40&r=${avatarRating}`] as const;
    })
  );
  return Object.fromEntries(entries);
}

function buildCommentOptions(options: SiteOptions, securityToken: string): CommentOptions {
  return {
    allowComment: true,
    requireMail: !!options.commentsRequireMail,
    showUrl: !!options.commentsShowUrl,
    showAvatar: !!options.commentsAvatar,
    avatarRating: options.commentsAvatarRating || 'G',
    order: options.commentsOrder === 'DESC' ? 'DESC' : 'ASC',
    dateFormat: options.commentDateFormat || 'Y-m-d H:i',
    timezone: options.timezone || 28800,
    securityToken,
    showCommentOnly: !!options.commentsShowCommentOnly,
    markdown: !!options.commentsMarkdown,
    urlNofollow: !!options.commentsUrlNofollow,
    threaded: !!options.commentsThreaded,
    maxNestingLevels: Number(options.commentsMaxNestingLevels) || 2,
    pageBreak: !!options.commentsPageBreak,
    pageSize: Number(options.commentsPageSize) || 20,
    pageDisplay: (options.commentsPageDisplay === 'first' ? 'first' : 'last') as 'first' | 'last',
    htmlTagAllowed: options.commentsHTMLTagAllowed || '',
  };
}

async function fetchAuthors(db: Database, authorIds: number[]): Promise<AuthorMap> {
  if (authorIds.length === 0) return new Map();
  const authors = await db.select().from(schema.users)
    .where(sql`${schema.users.uid} IN (${sql.join(authorIds.map(id => sql`${id}`), sql`, `)})`);
  return new Map(authors.map(a => [a.uid, a]));
}

async function fetchPostCategories(
  db: Database,
  postIds: number[],
  siteUrl: string,
  categoryPattern?: string | null,
): Promise<CategoryMap> {
  if (postIds.length === 0) return new Map();
  const rows = await db
    .select({
      cid: schema.relationships.cid,
      mid: schema.relationships.mid,
      name: schema.metas.name,
      slug: schema.metas.slug,
    })
    .from(schema.relationships)
    .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
    .where(
      and(
        sql`${schema.relationships.cid} IN (${sql.join(postIds.map(id => sql`${id}`), sql`, `)})`,
        eq(schema.metas.type, 'category')
      )
    );

  const map: CategoryMap = new Map();
  for (const row of rows) {
    if (!map.has(row.cid)) map.set(row.cid, []);
    map.get(row.cid)!.push({
      name: row.name || '',
      slug: row.slug || '',
      permalink: buildCategoryLink(row.slug || '', siteUrl, categoryPattern),
    });
  }
  return map;
}

function toPostListItem(
  post: ContentRow,
  authorMap: AuthorMap,
  categoryMap: CategoryMap,
  siteUrl: string,
  permalinkPattern?: string | null,
): PostListItem {
  const author = authorMap.get(post.authorId || 0);
  const categories = categoryMap.get(post.cid) || [];
  const permalink = buildPermalink(
    { cid: post.cid, slug: post.slug, type: post.type, created: post.created, category: categories[0]?.slug },
    siteUrl,
    permalinkPattern,
  );
  return {
    cid: post.cid,
    title: post.title || '无标题',
    permalink,
    excerpt: renderContentExcerpt(post.text || '', '- 阅读剩余部分 -', permalink),
    created: post.created || 0,
    commentsNum: post.commentsNum || 0,
    author: author ? { uid: author.uid, name: author.name || '', screenName: author.screenName || author.name || '' } : null,
    categories,
  };
}

// ─── Shared archive query ───────────────────────────────────────────────
// All five list pages (index, category, tag, author, search) share this
// pattern: count → paginated query → batch fetch authors+categories → map.

interface ArchiveParams {
  archiveTitle: string;
  archiveType: 'index' | 'category' | 'tag' | 'author' | 'search';
  baseUrl: string;
  /** Additional WHERE conditions beyond type='post' + status='publish' */
  extraWhere?: ReturnType<typeof sql>;
  /** If set, INNER JOIN relationships and filter on this meta ID */
  joinMid?: number;
  authorOverride?: AuthorMap;
}

async function prepareArchiveData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  params: ArchiveParams,
): Promise<ThemeArchiveProps> {
  const { db, options, urls } = ctx;
  const common = await loadCommon(ctx, requestUrl);
  const page = getPage(locals, url);
  const pageSize = options.pageSize || 5;

  const baseConditions = [eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')];
  if (params.extraWhere) baseConditions.push(params.extraWhere);

  const hasJoin = params.joinMid !== undefined;

  const countBase = hasJoin
    ? db.select({ count: sql<number>`count(*)` }).from(schema.contents)
        .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    : db.select({ count: sql<number>`count(*)` }).from(schema.contents);

  const countWhere = hasJoin
    ? and(eq(schema.relationships.mid, params.joinMid!), ...baseConditions)
    : and(...baseConditions);

  const countResult = await countBase.where(countWhere);
  const totalPosts = countResult[0]?.count || 0;
  const pg = paginate(totalPosts, page, pageSize, params.baseUrl);

  const listBase = hasJoin
    ? db.select({ content: schema.contents }).from(schema.contents)
        .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    : db.select().from(schema.contents);

  const posts = await listBase
    .where(countWhere)
    .orderBy(desc(schema.contents.created))
    .limit(pageSize)
    .offset((pg.currentPage - 1) * pageSize);

  const rawPosts: ContentRow[] = hasJoin
    ? (posts as { content: ContentRow }[]).map(p => p.content)
    : (posts as ContentRow[]);
  const authorIds = [...new Set(rawPosts.map(p => p.authorId).filter((id): id is number => Boolean(id)))];
  const postIds = rawPosts.map(p => p.cid).filter((id): id is number => id !== null);

  const authorMap = params.authorOverride ?? await fetchAuthors(db, authorIds);
  const categoryMap = await fetchPostCategories(db, postIds, urls.siteUrl, options.categoryPattern as string | undefined);

  return {
    ...common,
    archiveTitle: params.archiveTitle,
    archiveType: params.archiveType,
    posts: rawPosts.map(p =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination: pg,
  };
}

// ─── Index (home page) ──────────────────────────────────────────────────

export async function prepareIndexData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeIndexProps> {
  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: '',
    archiveType: 'index',
    baseUrl: ctx.urls.siteUrl + '/',
    extraWhere: sql`${schema.contents.created} < ${Math.floor(Date.now() / 1000)}`,
  });
}

// ─── Post detail ────────────────────────────────────────────────────────

export interface PreparePostResult {
  props: ThemePostProps;
  /** If set, the page route should return this Response instead */
  redirect?: never;
}

export async function preparePostData(
  ctx: RequestContext,
  cidNum: number,
  requestUrl: string,
  suppliedPassword: string | null,
): Promise<ThemePostProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const contentRow = await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cidNum),
  });

  if (!contentRow) return new Response('Not Found', { status: 404 });

  // Visibility checks
  const isPublished = contentRow.status === 'publish' || contentRow.status === 'hidden';
  const isPrivate = contentRow.status === 'private';
  const isDraft = contentRow.type?.endsWith('_draft');

  if (isDraft && (!isLoggedIn || user?.uid !== contentRow.authorId)) return new Response('Not Found', { status: 404 });
  if (isPrivate && (!isLoggedIn || user?.uid !== contentRow.authorId)) return new Response('Not Found', { status: 404 });
  if (!isPublished && !isPrivate && !isDraft) return new Response('Not Found', { status: 404 });

  // Password
  const hasPassword = !!contentRow.password;
  const passwordVerified = hasPassword && suppliedPassword === contentRow.password;

  // Author
  const author = contentRow.authorId
    ? await db.query.users.findFirst({ where: eq(schema.users.uid, contentRow.authorId) })
    : null;

  // Categories & Tags
  const relatedMetas = await db
    .select({ name: schema.metas.name, slug: schema.metas.slug, type: schema.metas.type })
    .from(schema.relationships)
    .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
    .where(eq(schema.relationships.cid, cidNum));

  type MetaEntry = { name: string | null; slug: string | null; type: string | null };
  const categories = (relatedMetas as MetaEntry[]).filter(m => m.type === 'category').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildCategoryLink(m.slug || '', urls.siteUrl, options.categoryPattern as string | undefined),
  }));
  const tags = (relatedMetas as MetaEntry[]).filter(m => m.type === 'tag').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildTagLink(m.slug || '', urls.siteUrl),
  }));

  // Prev / Next
  const prevPost = await db
    .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
    .from(schema.contents)
    .where(and(eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish'), lt(schema.contents.created, contentRow.created || 0)))
    .orderBy(desc(schema.contents.created))
    .limit(1);

  const nextPost = await db
    .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
    .from(schema.contents)
    .where(and(eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish'), gt(schema.contents.created, contentRow.created || 0)))
    .orderBy(asc(schema.contents.created))
    .limit(1);

  // Comments
  const commentsOrder = options.commentsOrder === 'DESC' ? desc(schema.comments.created) : asc(schema.comments.created);
  const allComments = await db
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.cid, cidNum), eq(schema.comments.status, 'approved')))
    .orderBy(commentsOrder);

  const commentTree = buildCommentTree(allComments);
  const gravatarMap = await buildGravatarMap(allComments, options.commentsAvatarRating || 'G');

  const permalink = buildPermalink(
    { cid: contentRow.cid, slug: contentRow.slug, type: contentRow.type, created: contentRow.created, category: categories[0]?.slug },
    urls.siteUrl,
    options.permalinkPattern as string | undefined,
  );

  const allowComment = contentRow.allowComment === '1';
  const renderedContent = hasPassword && !passwordVerified
    ? '<p>此内容已加密，请输入密码访问。</p>'
    : await renderMarkdownFiltered(contentRow.text || '');

  const common = await loadCommon(ctx, requestUrl);

  // Generate CSRF token for comment form (empty when anti-spam is disabled)
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, requestUrl)
    : '';

  return {
    ...common,
    post: {
      cid: contentRow.cid,
      title: contentRow.title || '无标题',
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
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    prevPost: prevPost[0] ? {
      title: prevPost[0].title || '无标题',
      permalink: buildPermalink(prevPost[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    nextPost: nextPost[0] ? {
      title: nextPost[0].title || '无标题',
      permalink: buildPermalink(nextPost[0], urls.siteUrl, options.permalinkPattern as string | undefined),
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
): Promise<ThemePageProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const pageRow = await db.query.contents.findFirst({
    where: and(eq(schema.contents.slug, cleanSlug), eq(schema.contents.type, 'page')),
  });

  if (!pageRow) return new Response('Not Found', { status: 404 });

  // Visibility
  if (pageRow.status !== 'publish' && pageRow.status !== 'hidden') {
    if (!isLoggedIn || (pageRow.status === 'private' && user?.uid !== pageRow.authorId)) {
      return new Response('Not Found', { status: 404 });
    }
  }

  const permalink = buildPermalink(
    { cid: pageRow.cid, slug: pageRow.slug, type: pageRow.type, created: pageRow.created },
    urls.siteUrl,
    undefined,
    options.pagePattern as string | undefined,
  );

  const hasPassword = !!pageRow.password;
  const passwordVerified = hasPassword && suppliedPassword === pageRow.password;

  // Comments
  const commentsOrder = options.commentsOrder === 'DESC' ? desc(schema.comments.created) : asc(schema.comments.created);
  const allComments = await db
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.cid, pageRow.cid), eq(schema.comments.status, 'approved')))
    .orderBy(commentsOrder);

  const commentTree = buildCommentTree(allComments);
  const gravatarMap = await buildGravatarMap(allComments, options.commentsAvatarRating || 'G');
  const allowComment = pageRow.allowComment === '1';

  const renderedContent = hasPassword && !passwordVerified
    ? '<p>此内容已加密，请输入密码访问。</p>'
    : await renderMarkdownFiltered(pageRow.text || '');

  const common = await loadCommon(ctx, requestUrl);

  // Generate CSRF token for comment form (empty when anti-spam is disabled)
  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, requestUrl)
    : '';

  return {
    ...common,
    page: {
      cid: pageRow.cid,
      title: pageRow.title || '无标题',
      slug: cleanSlug,
      permalink,
      content: renderedContent,
      created: pageRow.created || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    comments: commentTree,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    gravatarMap,
  };
}

// ─── Archive (category / tag / author / search) ─────────────────────────

export async function prepareCategoryData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  const category = await ctx.db.query.metas.findFirst({
    where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'category')),
  });
  if (!category) return new Response('Not Found', { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `分类 ${category.name} 下的文章`,
    archiveType: 'category',
    baseUrl: buildCategoryLink(slug, ctx.urls.siteUrl, ctx.options.categoryPattern as string | undefined),
    joinMid: category.mid,
  });
}

export async function prepareTagData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  const tag = await ctx.db.query.metas.findFirst({
    where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'tag')),
  });
  if (!tag) return new Response('Not Found', { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `标签 ${tag.name} 下的文章`,
    archiveType: 'tag',
    baseUrl: buildTagLink(slug, ctx.urls.siteUrl),
    joinMid: tag.mid,
  });
}

export async function prepareAuthorData(
  ctx: RequestContext,
  uidNum: number,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  const author = await ctx.db.query.users.findFirst({
    where: eq(schema.users.uid, uidNum),
  });
  if (!author) return new Response('Not Found', { status: 404 });

  const authorMap: AuthorMap = new Map([[author.uid, author]]);

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `${author.screenName || author.name} 发布的文章`,
    archiveType: 'author',
    baseUrl: buildAuthorLink(uidNum, ctx.urls.siteUrl),
    extraWhere: eq(schema.contents.authorId, uidNum),
    authorOverride: authorMap,
  });
}

export async function prepareSearchData(
  ctx: RequestContext,
  keywords: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeArchiveProps> {
  const searchTerm = `%${keywords}%`;

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `包含关键字 ${keywords} 的文章`,
    archiveType: 'search',
    baseUrl: buildSearchLink(keywords, ctx.urls.siteUrl),
    extraWhere: sql`(${schema.contents.title} LIKE ${searchTerm} OR ${schema.contents.text} LIKE ${searchTerm})`,
  });
}

// ─── 404 Not Found ──────────────────────────────────────────────────────

export async function prepareNotFoundData(
  ctx: RequestContext,
  requestUrl: string,
): Promise<ThemeNotFoundProps> {
  const common = await loadCommon(ctx, requestUrl);
  return {
    ...common,
    statusCode: 404,
    errorTitle: '404 - 页面没找到',
  };
}
