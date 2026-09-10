/**
 * Page data preparation layer
 *
 * Extracts DB queries from .astro page files into pure TypeScript functions.
 * Each function returns a standardized Props object for theme components.
 * This separation allows theme components to be purely presentational.
 */
import { eq, and, desc, asc, lt, gt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { DEFAULT_TIMEZONE } from '@/lib/timezone';
import { loadSidebarData, loadNavPages, type SidebarData } from '@/lib/sidebar';
import { createThemeI18n, loadThemeConfig } from '@/lib/theme';
import { buildFtsMatchExpression, contentsFtsTableRef, FTS_MIN_CHARS, isFtsAvailable } from '@/lib/fulltext';
import {
  buildPermalink, buildAuthorLink,
  buildCategoryLink, buildTagLink, buildSearchLink,
} from '@/lib/content';
import { renderContentExcerpt, renderCommentTextFiltered, renderMarkdownFiltered } from '@/lib/markdown';
import { paginate } from '@/lib/pagination';
import { generateCommentToken, timeSafeEqual } from '@/lib/auth';
import { buildGravatarUrl } from '@/lib/gravatar';
import { loadCommentPage } from '@/lib/comment-page';
import type { RequestContext } from '@/lib/context';
import { applyFilter, applyFilterSafely, doHook } from '@/lib/plugin';
import { canViewContent, publishedPostCondition } from '@/lib/content-visibility';
import { escapeHtml } from '@/lib/escape';
import { createI18n, type I18n } from '@/lib/i18n';
import { coreCatalogs } from '@/i18n/catalogs';
import type {
  ThemeIndexProps, ThemePostProps, ThemePageProps, ThemeArchiveProps, ThemeNotFoundProps,
  PostListItem, CommentNode, CommentOptions,
} from '@/lib/theme-props';

// ─── Local row types (derived from Drizzle schema) ───────────────────────

type ContentRow = typeof schema.contents.$inferSelect;
type CommentRow = typeof schema.comments.$inferSelect;
type MetaRow = typeof schema.metas.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
type CategoryEntry = { name: string; slug: string; permalink: string };
type CategoryMap = Map<number, CategoryEntry[]>;
type AuthorEntry = { uid: number; name: string | null; screenName: string | null };
type AuthorMap = Map<number, AuthorEntry>;

const EMPTY_SIDEBAR: SidebarData = {
  recentPosts: [],
  recentComments: [],
  categories: [],
  archives: [],
};

// Keep the pure page-data helpers compatible with lightweight test and
// extension contexts created before request i18n became mandatory.
const FALLBACK_I18N = createI18n({ locale: 'en', catalogs: coreCatalogs });
const FALLBACK_BUNDLE_NAME = 'en@catalog-1';

function getRequestI18n(ctx: RequestContext): I18n {
  return ctx.i18n ?? FALLBACK_I18N;
}

function getRequestBundleName(ctx: RequestContext): string {
  return ctx.resolvedLocale?.bundleName ?? FALLBACK_BUNDLE_NAME;
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function loadCommon(ctx: RequestContext, requestUrl: string, withSidebar = true) {
  const { db, options, urls, user, isLoggedIn } = ctx;
  const [sidebarData, pages] = await Promise.all([
    withSidebar
      ? loadSidebarData(
          ctx,
          db,
          urls.siteUrl,
          options.permalinkPattern as string | undefined,
          options.categoryPattern as string | undefined,
          options.pagePattern as string | undefined,
          options.cacheVersion,
          getRequestBundleName(ctx),
        )
      : Promise.resolve(EMPTY_SIDEBAR),
    loadNavPages(db, urls.siteUrl, options.pagePattern as string | undefined, options.cacheVersion, getRequestI18n(ctx), getRequestBundleName(ctx)),
  ]);
  const currentPath = new URL(requestUrl).pathname;
  return {
    options,
    urls,
    user,
    isLoggedIn,
    pages,
    sidebarData,
    currentPath,
    pluginCtx: ctx,
    themeConfig: loadThemeConfig(options, options.theme),
    i18n: createThemeI18n(options.theme, getRequestI18n(ctx), ctx.activatedPlugins),
  };
}

function getPage(locals: Record<string, unknown>, url: URL): number {
  const raw = (locals as { _page?: number })._page ?? url.searchParams.get('page');
  return raw ? (typeof raw === 'number' ? raw : parseInt(raw, 10) || 1) : 1;
}

async function filterContentRow(
  ctx: RequestContext,
  post: ContentRow,
  stage: 'list' | 'single',
): Promise<ContentRow> {
  const filtered = await applyFilterSafely(ctx, 'content:data', { ...post }, { content: post, stage });
  if (!filtered || typeof filtered !== 'object') return post;
  const candidate = filtered as Record<string, unknown>;
  const display: Partial<ContentRow> = {};
  if (typeof candidate.title === 'string' || candidate.title === null) display.title = candidate.title;
  if (typeof candidate.text === 'string' || candidate.text === null) display.text = candidate.text;
  if (typeof candidate.template === 'string' || candidate.template === null) display.template = candidate.template;
  if (typeof candidate.order === 'number' && Number.isFinite(candidate.order)) display.order = candidate.order;
  return {
    ...post,
    ...display,
    // Query, visibility, relationship, and permalink identity are system-owned.
    cid: post.cid,
    type: post.type,
    slug: post.slug,
    status: post.status,
    authorId: post.authorId,
    parent: post.parent,
    created: post.created,
    modified: post.modified,
    password: post.password,
    commentsNum: post.commentsNum,
    allowComment: post.allowComment,
    allowFeed: post.allowFeed,
    allowPing: post.allowPing,
  };
}

async function filterContentTitle(ctx: RequestContext, title: string, post: ContentRow): Promise<string> {
  const filtered = await applyFilterSafely(ctx, 'content:title', title, { content: post });
  return typeof filtered === 'string' ? filtered : title;
}

async function filterContentExcerpt(ctx: RequestContext, excerpt: string, post: ContentRow): Promise<string> {
  const filtered = await applyFilterSafely(ctx, 'content:excerpt', excerpt, { content: post });
  return typeof filtered === 'string' ? filtered : excerpt;
}

async function filterCommentRow(ctx: RequestContext, comment: CommentRow): Promise<CommentRow> {
  const filtered = await applyFilterSafely(ctx, 'comment:data', { ...comment }, { comment });
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

async function buildCommentTree(ctx: RequestContext, allComments: CommentRow[], options: SiteOptions): Promise<CommentNode[]> {
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
    });
  });

  if (!options.commentsThreaded) {
    return displayComments.map(comment => map.get(comment.coid)!);
  }

  for (const c of displayComments) {
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

function buildCommentOptions(options: SiteOptions, securityToken: string): CommentOptions {
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
    maxNestingLevels: Number(options.commentsMaxNestingLevels) || 2,
    pageBreak: !!options.commentsPageBreak,
    pageSize: Number(options.commentsPageSize) || 20,
    pageDisplay: (options.commentsPageDisplay === 'first' ? 'first' : 'last') as 'first' | 'last',
    htmlTagAllowed: options.commentsHTMLTagAllowed || '',
  };
}

async function fetchAuthors(db: Database, authorIds: number[]): Promise<AuthorMap> {
  if (authorIds.length === 0) return new Map();
  const authors = await db
    .select({
      uid: schema.users.uid,
      name: schema.users.name,
      screenName: schema.users.screenName,
    })
    .from(schema.users)
    .where(sql`${schema.users.uid} IN (${sql.join(authorIds.map(id => sql`${id}`), sql`, `)})`);
  return new Map(authors.map(a => [a.uid, a]));
}

function mapPostCategories(
  rows: Array<{ cid: number; mid: number; name: string | null; slug: string | null }>,
  siteUrl: string,
  categoryPattern?: string | null,
): CategoryMap {
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

async function toPostListItem(
  ctx: RequestContext,
  post: ContentRow,
  authorMap: AuthorMap,
  categoryMap: CategoryMap,
  siteUrl: string,
  permalinkPattern?: string | null,
): Promise<PostListItem> {
  const displayPost = await filterContentRow(ctx, post, 'list');
  const author = authorMap.get(displayPost.authorId || 0);
  const categories = categoryMap.get(displayPost.cid) || [];
  const permalink = buildPermalink(
    { cid: displayPost.cid, slug: displayPost.slug, type: displayPost.type, created: displayPost.created, category: categories[0]?.slug },
    siteUrl,
    permalinkPattern,
  );
  const title = await filterContentTitle(
    ctx,
    displayPost.title || getRequestI18n(ctx).t('core.content.untitled', {}, 'Untitled'),
    displayPost,
  );
  // A password-protected body must never reach a list view: the excerpt is
  // embedded in public archive HTML and written to the public edge cache, so
  // render the same "password required" placeholder the detail page uses.
  const excerpt = displayPost.password
    ? `<p>${escapeHtml(getRequestI18n(ctx).t('core.content.passwordProtected', {}, 'This content is password protected. Enter the password to view it.'))}</p>`
    : await filterContentExcerpt(
        ctx,
        renderContentExcerpt(
          displayPost.text || '',
          getRequestI18n(ctx).t('core.content.readMore', {}, '- Read more -'),
          permalink,
        ),
        displayPost,
      );
  return {
    cid: displayPost.cid,
    title,
    permalink,
    excerpt,
    created: displayPost.created || 0,
    commentsNum: displayPost.commentsNum || 0,
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
  hookPoint: 'archive:index' | 'archive:category' | 'archive:tag' | 'archive:author' | 'archive:search';
  hookParams: Record<string, string | number | undefined>;
  /** Additional WHERE conditions beyond type='post' + status='publish' */
  extraWhere?: ReturnType<typeof sql>;
  /** If set, INNER JOIN relationships and filter on this meta ID */
  joinMid?: number;
  authorOverride?: AuthorMap;
  /** FTS5 MATCH expression; set only for search (see prepareSearchData). */
  ftsMatch?: string | null;
  /** Stable key fragment for versioned archive count caching. */
  countKey?: string;
}

interface ArchiveLifecycleContext {
  archiveType: ArchiveParams['archiveType'] | 'single';
  requestUrl: string;
  path: string;
  params: Record<string, string | number | undefined>;
  options: SiteOptions;
  urls: RequestContext['urls'];
  user: RequestContext['user'];
}

interface ArchiveQueryState {
  page: number;
  pageSize: number;
  /** Optional plugin condition; system visibility and archive scope stay protected. */
  extraWhere?: ReturnType<typeof sql>;
}

function buildArchiveLifecycleContext(
  ctx: RequestContext,
  requestUrl: string,
  params: ArchiveParams,
): ArchiveLifecycleContext {
  return {
    archiveType: params.archiveType,
    requestUrl,
    path: new URL(requestUrl).pathname,
    params: params.hookParams,
    options: ctx.options,
    urls: ctx.urls,
    user: ctx.user,
  };
}

function isSqlCondition(value: unknown): value is ReturnType<typeof sql> {
  return !!value
    && typeof value === 'object'
    && Array.isArray((value as { queryChunks?: unknown }).queryChunks);
}

function clampArchivePage(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(10_000, Math.max(1, Math.floor(parsed))) : fallback;
}

function clampArchivePageSize(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.floor(parsed))) : fallback;
}

const ARCHIVE_COUNT_CACHE_TTL_MS = 60_000;
const ARCHIVE_COUNT_CACHE_MAX = 200;
const archiveCountCache = new Map<string, { count: number; expiresAt: number }>();

/** Test-only: clear archive count cache. */
export function resetArchiveCountCache(): void {
  archiveCountCache.clear();
}

function readCachedArchiveCount(key: string): number | undefined {
  const entry = archiveCountCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    archiveCountCache.delete(key);
    return undefined;
  }
  return entry.count;
}

function writeCachedArchiveCount(key: string, count: number): void {
  archiveCountCache.set(key, { count, expiresAt: Date.now() + ARCHIVE_COUNT_CACHE_TTL_MS });
  if (archiveCountCache.size <= ARCHIVE_COUNT_CACHE_MAX) return;
  const now = Date.now();
  for (const [cacheKey, entry] of archiveCountCache) {
    if (entry.expiresAt <= now) archiveCountCache.delete(cacheKey);
  }
  // Sweeping expired entries is not enough while a burst keeps every key
  // fresh: evict oldest-first until the map is back under the cap.
  while (archiveCountCache.size > ARCHIVE_COUNT_CACHE_MAX) {
    const oldest = archiveCountCache.keys().next().value;
    if (oldest === undefined) break;
    archiveCountCache.delete(oldest);
  }
}

async function prepareArchiveData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  params: ArchiveParams,
): Promise<ThemeArchiveProps> {
  const { db, options, urls } = ctx;
  const lifecycle = buildArchiveLifecycleContext(ctx, requestUrl, params);
  await doHook(ctx, 'archive:init', lifecycle);
  await doHook(ctx, params.hookPoint, lifecycle);

  const initialPage = getPage(locals, url);
  const defaultPageSize = Number(options.pageSize) || 5;
  const filteredQuery = await applyFilter(ctx, 'archive:query', {
    page: initialPage,
    pageSize: defaultPageSize,
  } as ArchiveQueryState, lifecycle) as Partial<ArchiveQueryState> | null | undefined;
  const page = clampArchivePage(filteredQuery?.page, initialPage);
  const pageSize = clampArchivePageSize(filteredQuery?.pageSize, defaultPageSize);
  const pluginWhere = isSqlCondition(filteredQuery?.extraWhere) ? filteredQuery.extraWhere : undefined;
  const commonPromise = loadCommon(ctx, requestUrl);

  // G7-5: every archive (index, category, tag, author, search) hides
  // posts whose `created` is in the future. The legacy code only
  // filtered the index page, leaking scheduled posts via category/tag
  // archives.
  const baseConditions = [
    publishedPostCondition(),
  ];
  if (params.extraWhere) baseConditions.push(params.extraWhere);
  if (pluginWhere) baseConditions.push(pluginWhere);
  if (params.ftsMatch) {
    baseConditions.push(sql`${contentsFtsTableRef} MATCH ${params.ftsMatch}`);
  }

  const hasJoin = params.joinMid !== undefined;
  const hasFts = !!params.ftsMatch;

  const countWhere = hasJoin
    ? and(eq(schema.relationships.mid, params.joinMid!), ...baseConditions)
    : and(...baseConditions);

  const applyJoins = (q: any): any => {
    let joined = q;
    if (hasJoin) {
      joined = joined.innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid));
    }
    if (hasFts) {
      joined = joined.innerJoin(
        contentsFtsTableRef,
        sql`${contentsFtsTableRef}.rowid = ${schema.contents.cid}`,
      );
    }
    return joined;
  };

  // Keyset pagination: ORDER BY created DESC, cid DESC with a (created, cid)
  // cursor from the previous page. Page 1 needs no offset at all; deeper
  // pages pay only an index-only boundary lookup instead of re-scanning the
  // skipped rows' full payload.
  const makeListStatement = (cursor: { created: number; cid: number } | null) => {
    const q = applyJoins(
      (hasJoin || hasFts)
        ? db.select({ content: schema.contents }).from(schema.contents)
        : db.select().from(schema.contents),
    );
    const where = cursor
      ? and(
          countWhere,
          or(
            lt(schema.contents.created, cursor.created),
            and(eq(schema.contents.created, cursor.created), lt(schema.contents.cid, cursor.cid)),
          ),
        )
      : countWhere;
    return q
      .where(where)
      .orderBy(desc(schema.contents.created), desc(schema.contents.cid))
      .limit(pageSize);
  };

  const makeBoundaryStatement = (offset: number) =>
    applyJoins(db.select({ created: schema.contents.created, cid: schema.contents.cid }).from(schema.contents))
      .where(countWhere)
      .orderBy(desc(schema.contents.created), desc(schema.contents.cid))
      .limit(1)
      .offset(offset);

  const requestedPage = Math.max(1, page);
  // Exact count so pagination shows accurate page numbers. The
  // (type, status, created) index keeps plain archive counts index-only.
  // Cache by cacheVersion + archive identity to avoid repeating count(*)
  // on every page view within an isolate.
  // A plugin-provided SQL condition is not represented by the normal archive
  // identity key. Skip the isolate count cache in that case rather than
  // returning a count produced for a different filtered result set.
  const useCountCache = !pluginWhere;
  const countCacheKey = `${options.cacheVersion}\0${params.archiveType}\0${params.countKey || params.baseUrl}\0${params.joinMid ?? ''}\0${params.ftsMatch || ''}`;
  const cachedCount = useCountCache ? readCachedArchiveCount(countCacheKey) : undefined;
  const countStatement = cachedCount === undefined
    ? applyJoins(
        db.select({ count: sql<number>`count(*)` }).from(schema.contents),
      ).where(countWhere)
    : null;

  // Batch the count with either the page-1 list (no cursor needed) or the
  // index-only boundary lookup for the requested page.
  const listOrBoundary = requestedPage === 1
    ? makeListStatement(null)
    : makeBoundaryStatement((requestedPage - 1) * pageSize - 1);
  const [common, batchResult] = await Promise.all([
    commonPromise,
    countStatement
      ? db.batch([countStatement, listOrBoundary])
      : db.batch([listOrBoundary]),
  ]);
  let totalPosts: number;
  let initialPosts: unknown;
  if (countStatement) {
    const [countResult, posts] = batchResult as [Array<{ count: number }>, unknown];
    totalPosts = Number(countResult?.[0]?.count ?? 0);
    if (useCountCache) writeCachedArchiveCount(countCacheKey, totalPosts);
    initialPosts = posts;
  } else {
    totalPosts = cachedCount!;
    initialPosts = batchResult[0];
  }
  const pg = paginate(totalPosts, page, pageSize, params.baseUrl);
  const currentPage = pg.currentPage;

  let posts: ContentRow[] | Array<{ content: ContentRow }>;
  if (requestedPage === 1) {
    posts = initialPosts as ContentRow[] | Array<{ content: ContentRow }>;
  } else if (currentPage === requestedPage) {
    const boundary = (initialPosts as Array<{ created: number | null; cid: number | null }>)[0];
    posts = boundary
      ? await makeListStatement({ created: boundary.created ?? 0, cid: boundary.cid ?? 0 })
      : [];
  } else {
    // Requested page was clamped (beyond the last page) — fetch the boundary
    // for the actual last page instead.
    const [boundaryRows] = await db.batch([
      makeBoundaryStatement((currentPage - 1) * pageSize - 1),
    ]);
    const boundary = boundaryRows[0];
    posts = boundary
      ? await makeListStatement({ created: boundary.created ?? 0, cid: boundary.cid ?? 0 })
      : [];
  }

  const rawPosts: ContentRow[] = (hasJoin || hasFts)
    ? (posts as { content: ContentRow }[]).map(p => p.content)
    : (posts as ContentRow[]);
  const authorIds = [...new Set(rawPosts.map(p => p.authorId).filter((id): id is number => Boolean(id)))];
  const postIds = rawPosts.map(p => p.cid).filter((id): id is number => id !== null);

  let authorMap = params.authorOverride;
  let categoryRows: Array<{ cid: number; mid: number; name: string | null; slug: string | null }> = [];
  if (postIds.length > 0) {
    const categoryStatement = db
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

    if (authorMap || authorIds.length === 0) {
      categoryRows = await categoryStatement;
    } else {
      const [authors, categories] = await db.batch([
        db
          .select({
            uid: schema.users.uid,
            name: schema.users.name,
            screenName: schema.users.screenName,
          })
          .from(schema.users)
          .where(sql`${schema.users.uid} IN (${sql.join(authorIds.map(id => sql`${id}`), sql`, `)})`),
        categoryStatement,
      ]);
      authorMap = new Map(authors.map(author => [author.uid, author]));
      categoryRows = categories;
    }
  }
  authorMap ??= await fetchAuthors(db, authorIds);
  const categoryMap = mapPostCategories(
    categoryRows,
    urls.siteUrl,
    options.categoryPattern as string | undefined,
  );

  return {
    ...common,
    archiveTitle: params.archiveTitle,
    archiveType: params.archiveType,
    posts: await Promise.all(rawPosts.map(p =>
      toPostListItem(ctx, p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined)
    )),
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
    hookPoint: 'archive:index',
    hookParams: {},
    // G7-5: future-post filter is shared by prepareArchiveData now, no
    // need to duplicate it here.
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
  preloadedRow?: ContentRow | null,
): Promise<ThemePostProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const contentRow = preloadedRow !== undefined
    ? preloadedRow
    : await db.query.contents.findFirst({
        where: eq(schema.contents.cid, cidNum),
      });

  if (!contentRow) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  if (!canViewContent(contentRow, { isLoggedIn, uid: user?.uid })) {
    return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });
  }

  const singleLifecycle: ArchiveLifecycleContext = {
    archiveType: 'single',
    requestUrl,
    path: new URL(requestUrl).pathname,
    params: { cid: contentRow.cid, type: contentRow.type || 'post' },
    options,
    urls,
    user,
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

  const commentTree = await buildCommentTree(ctx, allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};

  const permalink = buildPermalink(
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
): Promise<ThemePageProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  const pageRow = preloadedRow !== undefined
    ? preloadedRow
    : await db.query.contents.findFirst({
        where: and(eq(schema.contents.slug, cleanSlug), eq(schema.contents.type, 'page')),
      });

  if (!pageRow) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  if (!canViewContent(pageRow, { isLoggedIn, uid: user?.uid })) {
    return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });
  }

  const singleLifecycle: ArchiveLifecycleContext = {
    archiveType: 'single',
    requestUrl,
    path: new URL(requestUrl).pathname,
    params: { cid: pageRow.cid, slug: cleanSlug, type: 'page' },
    options,
    urls,
    user,
  };
  await doHook(ctx, 'archive:init', singleLifecycle);
  await doHook(ctx, 'archive:single', singleLifecycle);

  const displayPageRow = await filterContentRow(ctx, pageRow, 'single');
  const displayTitle = await filterContentTitle(
    ctx,
    displayPageRow.title || getRequestI18n(ctx).t('core.content.untitled', {}, 'Untitled'),
    displayPageRow,
  );

  const permalink = buildPermalink(
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

// ─── Archive (category / tag / author / search) ─────────────────────────

export async function prepareCategoryData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedCategory?: MetaRow | null,
): Promise<ThemeArchiveProps | Response> {
  const category = preloadedCategory === undefined
    ? await ctx.db.query.metas.findFirst({
        where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'category')),
      })
    : preloadedCategory;
  if (!category) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: getRequestI18n(ctx).t(
      'core.archive.categoryTitle',
      { category: category.name || getRequestI18n(ctx).t('core.archive.unknown', {}, 'Unknown') },
      'Posts in category {category}',
    ),
    archiveType: 'category',
    baseUrl: buildCategoryLink(slug, ctx.urls.siteUrl, ctx.options.categoryPattern as string | undefined),
    hookPoint: 'archive:category',
    hookParams: { slug, mid: category.mid },
    joinMid: category.mid,
  });
}

export async function prepareTagData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedTag?: MetaRow | null,
): Promise<ThemeArchiveProps | Response> {
  const tag = preloadedTag === undefined
    ? await ctx.db.query.metas.findFirst({
        where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'tag')),
      })
    : preloadedTag;
  if (!tag) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: getRequestI18n(ctx).t(
      'core.archive.tagTitle',
      { tag: tag.name || getRequestI18n(ctx).t('core.archive.unknown', {}, 'Unknown') },
      'Posts tagged {tag}',
    ),
    archiveType: 'tag',
    baseUrl: buildTagLink(slug, ctx.urls.siteUrl),
    hookPoint: 'archive:tag',
    hookParams: { slug, mid: tag.mid },
    joinMid: tag.mid,
  });
}

export async function prepareAuthorData(
  ctx: RequestContext,
  uidNum: number,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedAuthor?: UserRow | null,
): Promise<ThemeArchiveProps | Response> {
  const author = preloadedAuthor === undefined
    ? await ctx.db.query.users.findFirst({ where: eq(schema.users.uid, uidNum) })
    : preloadedAuthor;
  if (!author) return new Response(getRequestI18n(ctx).t('core.error.notFound', {}, 'Not Found'), { status: 404 });

  const authorMap: AuthorMap = new Map([[author.uid, author]]);

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: getRequestI18n(ctx).t(
      'core.archive.authorTitle',
      { author: author.screenName || author.name || getRequestI18n(ctx).t('core.archive.unknown', {}, 'Unknown') },
      'Posts by {author}',
    ),
    archiveType: 'author',
    baseUrl: buildAuthorLink(uidNum, ctx.urls.siteUrl),
    hookPoint: 'archive:author',
    hookParams: { uid: uidNum },
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
  // G4-5: bound keyword length both as a UX guard (single chars match
  // huge swaths of LIKE) and as a cheap rate-limit on D1 LIKE scans.
  const trimmed = keywords.trim().slice(0, 50);
  const isUsefulKeyword = trimmed.length >= 2;
  // FTS5's trigram tokenizer only indexes/matches terms of >= FTS_MIN_CHARS;
  // shorter quoted terms are silently dropped by MATCH (a keyword like
  // "to be" or "性能 优化" would match nothing). Enable FTS only when EVERY
  // whitespace-separated term is long enough — otherwise the LIKE branch
  // below matches the literal substring, preserving multi-term semantics.
  const terms = trimmed.split(/\s+/).filter(Boolean);
  const useFts = isUsefulKeyword
    && terms.length > 0
    && terms.every((term) => term.length >= FTS_MIN_CHARS)
    && isFtsAvailable();

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: getRequestI18n(ctx).t(
      'core.archive.searchTitle',
      { keywords: trimmed },
      'Posts containing {keywords}',
    ),
    archiveType: 'search',
    baseUrl: buildSearchLink(trimmed, ctx.urls.siteUrl),
    hookPoint: 'archive:search',
    hookParams: { keywords: trimmed },
    // empty/too-short keyword → no results, never scans; keywords with any
    // short term (or an unavailable FTS index) keep the LIKE scan.
    extraWhere: !isUsefulKeyword
      ? sql`1 = 0`
      : useFts
        ? undefined
        : sql`(${schema.contents.title} LIKE ${`%${trimmed}%`} OR ${schema.contents.text} LIKE ${`%${trimmed}%`})`,
    ftsMatch: useFts ? buildFtsMatchExpression(trimmed) : null,
  });
}

// ─── 404 Not Found ──────────────────────────────────────────────────────

export async function prepareNotFoundData(
  ctx: RequestContext,
  requestUrl: string,
): Promise<ThemeNotFoundProps> {
  // 404 responses skip the sidebar widget queries (recent posts/comments,
  // categories, monthly archives) — error pages render chrome from the nav
  // pages only, so bot storms on dead URLs don't rebuild sidebar snapshots.
  const common = await loadCommon(ctx, requestUrl, false);
  return {
    ...common,
    statusCode: 404,
    errorTitle: getRequestI18n(ctx).t('core.error.notFoundTitle', {}, '404 - Page not found'),
  };
}
