/**
 * Page data preparation layer
 *
 * Extracts DB queries from .astro page files into pure TypeScript functions.
 * Each function returns a standardized Props object for theme components.
 * This separation allows theme components to be purely presentational.
 */
import { eq, and, desc, asc, lt, gt, sql, like } from 'drizzle-orm';
import { schema } from '@/db';
import { loadSidebarData, loadNavPages } from '@/lib/sidebar';
import {
  buildPermalink, formatDate, buildAuthorLink,
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

function getPage(locals: any, url: URL): number {
  const pageParam = locals._page || url.searchParams.get('page');
  return pageParam ? (typeof pageParam === 'number' ? pageParam : parseInt(pageParam, 10) || 1) : 1;
}

async function sha256hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildCommentTree(allComments: any[]): CommentNode[] {
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

async function buildGravatarMap(allComments: any[], avatarRating: string): Promise<Record<number, string>> {
  const entries = await Promise.all(
    allComments.map(async (c) => {
      const hash = c.mail ? await sha256hex(c.mail) : '';
      return [c.coid, `https://gravatar.com/avatar/${hash}?d=identicon&s=40&r=${avatarRating}`] as const;
    })
  );
  return Object.fromEntries(entries);
}

function buildCommentOptions(options: any, securityToken: string): CommentOptions {
  return {
    allowComment: true, // caller overrides as needed
    requireMail: !!options.commentsRequireMail,
    showUrl: !!options.commentsShowUrl,
    showAvatar: !!options.commentsAvatar,
    avatarRating: options.commentsAvatarRating || 'G',
    order: options.commentsOrder === 'DESC' ? 'DESC' : 'ASC',
    dateFormat: options.commentDateFormat || 'Y-m-d H:i',
    timezone: options.timezone || 28800,
    securityToken,
    
    // Display settings
    showCommentOnly: !!options.commentsShowCommentOnly,
    markdown: !!options.commentsMarkdown,
    urlNofollow: !!options.commentsUrlNofollow,
    
    // Threading & pagination
    threaded: !!options.commentsThreaded,
    maxNestingLevels: Number(options.commentsMaxNestingLevels) || 2,
    pageBreak: !!options.commentsPageBreak,
    pageSize: Number(options.commentsPageSize) || 20,
    pageDisplay: (options.commentsPageDisplay === 'first' ? 'first' : 'last') as 'first' | 'last',
    
    // HTML filtering
    htmlTagAllowed: options.commentsHTMLTagAllowed || '',
  };
}

// Fetch authors for a set of posts
async function fetchAuthors(db: any, authorIds: number[]) {
  if (authorIds.length === 0) return new Map<number, any>();
  const authors = await db.select().from(schema.users)
    .where(sql`${schema.users.uid} IN (${sql.join(authorIds.map((id: number) => sql`${id}`), sql`, `)})`);
  return new Map<number, any>(authors.map((a: any) => [a.uid, a]));
}

// Fetch categories for a set of post IDs
async function fetchPostCategories(db: any, postIds: number[], siteUrl: string, categoryPattern?: string | null) {
  if (postIds.length === 0) return new Map<number, Array<{ name: string; slug: string; permalink: string }>>();
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
        sql`${schema.relationships.cid} IN (${sql.join(postIds.map((id: number) => sql`${id}`), sql`, `)})`,
        eq(schema.metas.type, 'category')
      )
    );

  const map = new Map<number, Array<{ name: string; slug: string; permalink: string }>>();
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
  post: any,
  authorMap: Map<number, any>,
  categoryMap: Map<number, Array<{ name: string; slug: string; permalink: string }>>,
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
    author: author ? { uid: author.uid, name: author.name, screenName: author.screenName || author.name } : null,
    categories,
  };
}

// ─── Index (home page) ──────────────────────────────────────────────────

export async function prepareIndexData(
  ctx: RequestContext,
  requestUrl: string,
  locals: any,
  url: URL,
): Promise<ThemeIndexProps> {
  const { db, options, urls } = ctx;
  const common = await loadCommon(ctx, requestUrl);
  const page = getPage(locals, url);

  // Count
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        sql`${schema.contents.created} < ${Math.floor(Date.now() / 1000)}`
      )
    );
  const totalPosts = countResult[0]?.count || 0;
  const pagination = paginate(totalPosts, page, options.pageSize || 5, urls.siteUrl + '/');

  // Posts
  const posts = await db
    .select()
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        sql`${schema.contents.created} < ${Math.floor(Date.now() / 1000)}`
      )
    )
    .orderBy(desc(schema.contents.created))
    .limit(options.pageSize || 5)
    .offset((pagination.currentPage - 1) * (options.pageSize || 5));

  const authorIds = [...new Set(posts.map((p: any) => p.authorId).filter(Boolean))];
  const postIds = posts.map((p: any) => p.cid);

  const [authorMap, categoryMap] = await Promise.all([
    fetchAuthors(db, authorIds),
    fetchPostCategories(db, postIds, urls.siteUrl, options.categoryPattern as string | undefined),
  ]);

  return {
    ...common,
    posts: posts.map((p: any) =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination,
  };
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

  const categories = relatedMetas.filter((m: any) => m.type === 'category').map((m: any) => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildCategoryLink(m.slug || '', urls.siteUrl, options.categoryPattern as string | undefined),
  }));
  const tags = relatedMetas.filter((m: any) => m.type === 'tag').map((m: any) => ({
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
    author: author ? { uid: author.uid, name: author.name, screenName: author.screenName || author.name } : null,
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
  locals: any,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  const { db, options, urls } = ctx;

  const category = await db.query.metas.findFirst({
    where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'category')),
  });
  if (!category) return new Response('Not Found', { status: 404 });

  const page = getPage(locals, url);
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(and(eq(schema.relationships.mid, category.mid), eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')));

  const totalPosts = countResult[0]?.count || 0;
  const pagination = paginate(totalPosts, page, options.pageSize || 5, buildCategoryLink(slug, urls.siteUrl, options.categoryPattern as string | undefined));

  const posts = await db
    .select({ content: schema.contents })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(and(eq(schema.relationships.mid, category.mid), eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')))
    .orderBy(desc(schema.contents.created))
    .limit(options.pageSize || 5)
    .offset((pagination.currentPage - 1) * (options.pageSize || 5));

  const rawPosts = posts.map((p: any) => p.content);
  const authorIds = [...new Set(rawPosts.map((p: any) => p.authorId).filter(Boolean))];
  const postIds = rawPosts.map((p: any) => p.cid);

  const [authorMap, categoryMap] = await Promise.all([
    fetchAuthors(db, authorIds),
    fetchPostCategories(db, postIds, urls.siteUrl, options.categoryPattern as string | undefined),
  ]);

  const common = await loadCommon(ctx, requestUrl);

  return {
    ...common,
    archiveTitle: `分类 ${category.name} 下的文章`,
    archiveType: 'category',
    posts: rawPosts.map((p: any) =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination,
  };
}

export async function prepareTagData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: any,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  const { db, options, urls } = ctx;

  const tag = await db.query.metas.findFirst({
    where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'tag')),
  });
  if (!tag) return new Response('Not Found', { status: 404 });

  const page = getPage(locals, url);
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(and(eq(schema.relationships.mid, tag.mid), eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')));

  const totalPosts = countResult[0]?.count || 0;
  const pagination = paginate(totalPosts, page, options.pageSize || 5, buildTagLink(slug, urls.siteUrl));

  const posts = await db
    .select({ content: schema.contents })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(and(eq(schema.relationships.mid, tag.mid), eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')))
    .orderBy(desc(schema.contents.created))
    .limit(options.pageSize || 5)
    .offset((pagination.currentPage - 1) * (options.pageSize || 5));

  const rawPosts = posts.map((p: any) => p.content);
  const authorIds = [...new Set(rawPosts.map((p: any) => p.authorId).filter(Boolean))];
  const postIds = rawPosts.map((p: any) => p.cid);

  const [authorMap, categoryMap] = await Promise.all([
    fetchAuthors(db, authorIds),
    fetchPostCategories(db, postIds, urls.siteUrl, options.categoryPattern as string | undefined),
  ]);

  const common = await loadCommon(ctx, requestUrl);

  return {
    ...common,
    archiveTitle: `标签 ${tag.name} 下的文章`,
    archiveType: 'tag',
    posts: rawPosts.map((p: any) =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination,
  };
}

export async function prepareAuthorData(
  ctx: RequestContext,
  uidNum: number,
  requestUrl: string,
  locals: any,
  url: URL,
): Promise<ThemeArchiveProps | Response> {
  const { db, options, urls } = ctx;

  const author = await db.query.users.findFirst({
    where: eq(schema.users.uid, uidNum),
  });
  if (!author) return new Response('Not Found', { status: 404 });

  const page = getPage(locals, url);
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contents)
    .where(and(eq(schema.contents.authorId, uidNum), eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')));

  const totalPosts = countResult[0]?.count || 0;
  const pagination = paginate(totalPosts, page, options.pageSize || 5, buildAuthorLink(uidNum, urls.siteUrl));

  const posts = await db
    .select()
    .from(schema.contents)
    .where(and(eq(schema.contents.authorId, uidNum), eq(schema.contents.type, 'post'), eq(schema.contents.status, 'publish')))
    .orderBy(desc(schema.contents.created))
    .limit(options.pageSize || 5)
    .offset((pagination.currentPage - 1) * (options.pageSize || 5));

  // Author is already known, build a simple map
  const authorMap = new Map<number, any>([[author.uid, author]]);
  const postIds = posts.map((p: any) => p.cid);
  const categoryMap = await fetchPostCategories(db, postIds, urls.siteUrl, options.categoryPattern as string | undefined);

  const common = await loadCommon(ctx, requestUrl);

  return {
    ...common,
    archiveTitle: `${author.screenName || author.name} 发布的文章`,
    archiveType: 'author',
    posts: posts.map((p: any) =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination,
  };
}

export async function prepareSearchData(
  ctx: RequestContext,
  keywords: string,
  requestUrl: string,
  locals: any,
  url: URL,
): Promise<ThemeArchiveProps> {
  const { db, options, urls } = ctx;

  const page = getPage(locals, url);
  const searchTerm = `%${keywords}%`;

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        sql`(${schema.contents.title} LIKE ${searchTerm} OR ${schema.contents.text} LIKE ${searchTerm})`
      )
    );

  const totalPosts = countResult[0]?.count || 0;
  const pagination = paginate(totalPosts, page, options.pageSize || 5, buildSearchLink(keywords, urls.siteUrl));

  const posts = await db
    .select()
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        sql`(${schema.contents.title} LIKE ${searchTerm} OR ${schema.contents.text} LIKE ${searchTerm})`
      )
    )
    .orderBy(desc(schema.contents.created))
    .limit(options.pageSize || 5)
    .offset((pagination.currentPage - 1) * (options.pageSize || 5));

  const authorIds = [...new Set(posts.map((p: any) => p.authorId).filter(Boolean))];
  const postIds = posts.map((p: any) => p.cid);

  const [authorMap, categoryMap] = await Promise.all([
    fetchAuthors(db, authorIds),
    fetchPostCategories(db, postIds, urls.siteUrl, options.categoryPattern as string | undefined),
  ]);

  const common = await loadCommon(ctx, requestUrl);

  return {
    ...common,
    archiveTitle: `包含关键字 ${keywords} 的文章`,
    archiveType: 'search',
    posts: posts.map((p: any) =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    ),
    pagination,
  };
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
