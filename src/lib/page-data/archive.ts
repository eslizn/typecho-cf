import { eq, and, desc, asc, lt, gt, or, sql } from 'drizzle-orm';
import { schema } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { buildFtsMatchExpression, contentsFtsTableRef, FTS_MIN_CHARS, isFtsAvailable } from '@/lib/fulltext';
import { buildAuthorLink, buildCategoryLink, buildTagLink, buildSearchLink } from '@/lib/content';
import { paginate } from '@/lib/pagination';
import type { RequestContext } from '@/lib/context';
import { applyFilter, doHook } from '@/lib/plugin';
import { publishedPostCondition } from '@/lib/content-visibility';
import type { ThemeArchiveProps, ThemeIndexProps } from '@/lib/theme-props';
import {
  fetchAuthors,
  getPage,
  getRequestI18n,
  loadCommon,
  mapPostCategories,
  toPostListItem,
  type AuthorMap,
  type ContentRow,
  type MetaRow,
  type UserRow,
} from './common';

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
  capabilityRuntime: RequestContext['capabilityRuntime'];
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
    capabilityRuntime: ctx.capabilityRuntime,
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
