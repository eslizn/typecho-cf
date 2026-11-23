import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';

export type CommentRow = typeof schema.comments.$inferSelect;

export interface CommentPagination {
  enabled: boolean;
  currentPage: number;
  totalPages: number;
  totalComments: number;
  pageSize: number;
  pages: number[];
  pageUrls: Record<number, string>;
  prevUrl: string | null;
  nextUrl: string | null;
  replyPage?: { currentPage: number; backUrl: string; prevUrl: string | null; nextUrl: string | null };
}

export interface CommentPage {
  rows: CommentRow[];
  pagination: CommentPagination;
  replyLinks?: Record<number, string>;
}

const COMMENT_PAGE_SIZE_MAX = 100;
const COMMENT_UNPAGED_MAX = 200;
const THREAD_PREVIEW_REPLIES_PER_PARENT = 20;
const THREAD_REPLY_PAGE_SIZE = 25;

function replyPageUrl(requestUrl: URL, parent: number | null, page = 1): string {
  const url = new URL(requestUrl);
  if (parent === null) url.searchParams.delete('commentThread');
  else url.searchParams.set('commentThread', String(parent));
  if (parent !== null && page > 1) url.searchParams.set('replyPage', String(page));
  else url.searchParams.delete('replyPage');
  url.hash = parent === null ? 'comments' : `comment-${parent}`;
  return url.toString();
}

// Root counts scan every comment on a content (NOT EXISTS per row), so they
// are cached per (cacheVersion, cid). Every write path bumps cacheVersion,
// which naturally invalidates the entry; the TTL is a safety net for direct
// DB writes outside the version bump and is enforced on read.
const COMMENT_ROOT_CACHE_TTL_MS = 60_000;
const COMMENT_ROOT_CACHE_MAX_ENTRIES = 200;
const commentRootCounts = new Map<string, { count: number; expiresAt: number }>();

function readCachedRootCount(key: string): number | undefined {
  const entry = commentRootCounts.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    commentRootCounts.delete(key);
    return undefined;
  }
  return entry.count;
}

function writeCachedRootCount(key: string, count: number): void {
  commentRootCounts.set(key, { count, expiresAt: Date.now() + COMMENT_ROOT_CACHE_TTL_MS });
  // The key embeds cacheVersion, which grows on every content write; sweep
  // expired entries once the map gets large so a long-lived isolate never
  // accumulates stale keys unboundedly.
  if (commentRootCounts.size > COMMENT_ROOT_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [cacheKey, entry] of commentRootCounts) {
      if (entry.expiresAt <= now) commentRootCounts.delete(cacheKey);
    }
    // A burst can fill the map with entries whose TTL has not expired yet.
    // Expiry alone does not enforce the documented per-isolate capacity.
    while (commentRootCounts.size > COMMENT_ROOT_CACHE_MAX_ENTRIES) {
      const oldest = commentRootCounts.keys().next().value;
      if (oldest === undefined) break;
      commentRootCounts.delete(oldest);
    }
  }
}

/** Test-only: reset the in-isolate root-count cache. */
export function resetCommentRootCountCache(): void {
  commentRootCounts.clear();
}

function pageUrl(requestUrl: string, page: number, defaultPage: number): string {
  const url = new URL(requestUrl);
  url.hash = 'comments';
  if (page === defaultPage) url.searchParams.delete('commentPage');
  else url.searchParams.set('commentPage', String(page));
  return url.toString();
}

function visiblePages(currentPage: number, totalPages: number): number[] {
  let start = Math.max(1, currentPage - 4);
  const end = Math.min(totalPages, start + 9);
  start = Math.max(1, end - 9);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function buildPagination(
  requestUrl: string,
  enabled: boolean,
  requestedPage: number | null,
  defaultDisplay: 'first' | 'last',
  pageSize: number,
  totalPageItems: number,
  totalComments: number,
): CommentPagination {
  const totalPages = enabled ? Math.max(1, Math.ceil(totalPageItems / pageSize)) : 1;
  const defaultPage = defaultDisplay === 'last' ? totalPages : 1;
  const currentPage = enabled
    ? Math.min(Math.max(1, requestedPage ?? defaultPage), totalPages)
    : 1;
  const pages = visiblePages(currentPage, totalPages);
  return {
    enabled,
    currentPage,
    totalPages,
    totalComments,
    pageSize,
    pages,
    pageUrls: Object.fromEntries(pages.map(page => [page, pageUrl(requestUrl, page, defaultPage)])),
    prevUrl: currentPage > 1 ? pageUrl(requestUrl, currentPage - 1, defaultPage) : null,
    nextUrl: currentPage < totalPages ? pageUrl(requestUrl, currentPage + 1, defaultPage) : null,
  };
}

/**
 * Load one bounded comment thread page. Threaded mode paginates root comments
 * and uses a recursive CTE to keep every selected root's descendants together.
 */
export async function loadCommentPage(
  db: Database,
  cid: number,
  options: SiteOptions,
  requestUrl: string,
  commentsNum?: number | null,
  cacheVersion: string | number = 0,
): Promise<CommentPage> {
  const enabled = !!options.commentsPageBreak;
  const threaded = !!options.commentsThreaded;
  const pageSize = Math.min(
    COMMENT_PAGE_SIZE_MAX,
    Math.max(1, Number(options.commentsPageSize) || 20),
  );
  const order = options.commentsOrder === 'DESC' ? 'DESC' : 'ASC';
  const orderExpression = order === 'DESC'
    ? desc(schema.comments.created)
    : asc(schema.comments.created);
  const commentUrl = new URL(requestUrl);
  const threadParent = Number(commentUrl.searchParams.get('commentThread'));
  const showThread = threaded && Number.isSafeInteger(threadParent) && threadParent > 0;
  const rawPage = commentUrl.searchParams.get('commentPage');
  const parsedPage = rawPage ? Number.parseInt(rawPage, 10) : Number.NaN;
  const requestedPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : null;
  const display = options.commentsPageDisplay === 'first' ? 'first' : 'last';
  const approvedForContent = and(
    eq(schema.comments.cid, cid),
    eq(schema.comments.status, 'approved'),
  );
  const approvedRootForContent = and(
    approvedForContent,
    sql`(
      ${schema.comments.parent} = 0
      OR NOT EXISTS (
        SELECT 1
        FROM ${schema.comments} AS parent_comment
        WHERE parent_comment.coid = ${schema.comments.parent}
          AND parent_comment.cid = ${cid}
          AND parent_comment.status = 'approved'
      )
    )`,
  );

  // contents.commentsNum (maintained by the comment write/moderation paths)
  // is a single PK read the caller already did — prefer it over a count(*)
  // scan of every comment on the content.
  const hasStoredCount = typeof commentsNum === 'number' && Number.isFinite(commentsNum) && commentsNum >= 0;

  if (!enabled && !showThread && (!hasStoredCount || commentsNum! <= COMMENT_UNPAGED_MAX)) {
    // Probe the total with the same round trip as the bounded row fetch. Small
    // unpaged comment sets retain the legacy response shape; larger sets are
    // transparently promoted to paged mode instead of materialising everything.
    const statements: any[] = [];
    if (!hasStoredCount) {
      statements.push(
        db.select({ count: sql<number>`count(*)` }).from(schema.comments).where(approvedForContent),
      );
    }
    statements.push(
      db
        .select()
        .from(schema.comments)
        .where(approvedForContent)
        .orderBy(orderExpression)
        .limit(COMMENT_UNPAGED_MAX),
    );
    const results = await db.batch(statements as [any, ...any[]]);
    const counted = hasStoredCount
      ? commentsNum!
      : Number(results[0][0]?.count ?? 0);
    const rows = results[results.length - 1] as CommentRow[];
    if (counted <= COMMENT_UNPAGED_MAX) {
      const total = Math.max(counted, rows.length);
      return {
        rows,
        pagination: buildPagination(
          requestUrl,
          false,
          null,
          display,
          pageSize,
          total,
          total,
        ),
      };
    }
  }

  const rootCacheKey = `${cacheVersion}\0${cid}\0${threaded}\0${order}`;
  const cachedRootCount = threaded ? readCachedRootCount(rootCacheKey) : undefined;

  const countStatements: any[] = [];
  if (!hasStoredCount) {
    countStatements.push(
      db.select({ count: sql<number>`count(*)` }).from(schema.comments).where(approvedForContent),
    );
  }
  if (threaded && cachedRootCount === undefined) {
    countStatements.push(
      db.select({ count: sql<number>`count(*)` }).from(schema.comments).where(approvedRootForContent),
    );
  }

  let totalComments = hasStoredCount ? commentsNum! : 0;
  let totalPageItems = 0;
  if (countStatements.length > 0) {
    const countResults = await db.batch(countStatements as [any, ...any[]]);
    let index = 0;
    if (!hasStoredCount) {
      totalComments = Number(countResults[index][0]?.count ?? 0);
      index += 1;
    }
    if (threaded && cachedRootCount === undefined) {
      totalPageItems = Number(countResults[index][0]?.count ?? 0);
      writeCachedRootCount(rootCacheKey, totalPageItems);
    }
  }
  if (threaded && cachedRootCount !== undefined) {
    totalPageItems = cachedRootCount;
  }
  if (!threaded) {
    totalPageItems = totalComments;
  }

  const pagination = buildPagination(
    requestUrl,
    true,
    requestedPage,
    display,
    pageSize,
    totalPageItems,
    totalComments,
  );
  const pageOffset = (pagination.currentPage - 1) * pageSize;

  if (!threaded) {
    // Keyset page: index-only boundary seek, then (created, coid) range.
    // Page 1 needs no seek; deeper pages avoid OFFSET over full comment rows.
    let cursor: { created: number; coid: number } | null = null;
    if (pageOffset > 0) {
      const [boundary] = await db
        .select({ created: schema.comments.created, coid: schema.comments.coid })
        .from(schema.comments)
        .where(approvedForContent)
        .orderBy(orderExpression, order === 'DESC' ? desc(schema.comments.coid) : asc(schema.comments.coid))
        .limit(1)
        .offset(pageOffset - 1);
      if (!boundary) return { rows: [], pagination };
      cursor = { created: boundary.created ?? 0, coid: boundary.coid };
    }

    const tieOrder = order === 'DESC' ? desc(schema.comments.coid) : asc(schema.comments.coid);
    const cursorWhere = cursor
      ? order === 'DESC'
        ? sql`(
            ${schema.comments.created} < ${cursor.created}
            OR (${schema.comments.created} = ${cursor.created} AND ${schema.comments.coid} < ${cursor.coid})
          )`
        : sql`(
            ${schema.comments.created} > ${cursor.created}
            OR (${schema.comments.created} = ${cursor.created} AND ${schema.comments.coid} > ${cursor.coid})
          )`
      : null;
    const rows = await db
      .select()
      .from(schema.comments)
      .where(cursorWhere ? and(approvedForContent, cursorWhere) : approvedForContent)
      .orderBy(orderExpression, tieOrder)
      .limit(pageSize);
    return { rows, pagination };
  }

  const replyOrder = order === 'DESC' ? desc(schema.comments.coid) : asc(schema.comments.coid);
  if (showThread) {
    const rootPage = replyPageUrl(commentUrl, null);
    const rawReplyPage = Number(commentUrl.searchParams.get('replyPage'));
    const replyPage = Number.isSafeInteger(rawReplyPage) && rawReplyPage > 0
      && Number.isSafeInteger(rawReplyPage * THREAD_REPLY_PAGE_SIZE) ? rawReplyPage : 1;
    const [[parent], replies] = await db.batch([
      db.select().from(schema.comments)
        .where(and(approvedForContent, eq(schema.comments.coid, threadParent)))
        .limit(1),
      db.select({
        comment: schema.comments,
        hasReplies: sql<number>`EXISTS (
          SELECT 1 FROM typecho_comments AS child
          WHERE child.cid = ${cid} AND child.status = 'approved'
            AND child.parent = typecho_comments.coid
        )`,
      }).from(schema.comments)
        .where(and(approvedForContent, eq(schema.comments.parent, threadParent)))
        .orderBy(orderExpression, replyOrder)
        .limit(THREAD_REPLY_PAGE_SIZE + 1)
        .offset((replyPage - 1) * THREAD_REPLY_PAGE_SIZE),
    ]);
    if (parent) {
      const visibleReplies = replies.slice(0, THREAD_REPLY_PAGE_SIZE);
      return {
        rows: [{ ...parent, parent: 0 }, ...visibleReplies.map(row => row.comment)],
        pagination: {
          ...pagination,
          replyPage: {
            currentPage: replyPage,
            backUrl: rootPage,
            prevUrl: replyPage > 1 ? replyPageUrl(commentUrl, threadParent, replyPage - 1) : null,
            nextUrl: replies.length > THREAD_REPLY_PAGE_SIZE
              ? replyPageUrl(commentUrl, threadParent, replyPage + 1) : null,
          },
        },
        replyLinks: Object.fromEntries(visibleReplies.filter(row => row.hasReplies)
          .map(({ comment }) => [comment.coid, replyPageUrl(commentUrl, comment.coid)])),
      };
    }
    return loadCommentPage(db, cid, options, rootPage, commentsNum, cacheVersion);
  }

  const orderSql = order === 'DESC' ? sql`DESC` : sql`ASC`;
  const coidOrderSql = order === 'DESC' ? sql`DESC` : sql`ASC`;
  // Seek the root boundary with an index-friendly OFFSET on (created, coid)
  // only, then keyset-select the page of roots for the recursive thread CTE.
  let rootCursor: { created: number; coid: number } | null = null;
  if (pageOffset > 0) {
    const boundaryRows = await db.all<{ created: number; coid: number }>(sql`
      SELECT candidate.created AS created, candidate.coid AS coid
      FROM ${schema.comments} AS candidate
      WHERE candidate.cid = ${cid}
        AND candidate.status = 'approved'
        AND (
          candidate.parent = 0
          OR NOT EXISTS (
            SELECT 1
            FROM ${schema.comments} AS parent_comment
            WHERE parent_comment.coid = candidate.parent
              AND parent_comment.cid = ${cid}
              AND parent_comment.status = 'approved'
          )
        )
      ORDER BY candidate.created ${orderSql}, candidate.coid ${coidOrderSql}
      LIMIT 1 OFFSET ${pageOffset - 1}
    `);
    const boundary = boundaryRows[0];
    if (!boundary) return { rows: [], pagination };
    rootCursor = { created: boundary.created ?? 0, coid: boundary.coid };
  }

  const rootCursorSql = rootCursor
    ? order === 'DESC'
      ? sql`AND (
          candidate.created < ${rootCursor.created}
          OR (candidate.created = ${rootCursor.created} AND candidate.coid < ${rootCursor.coid})
        )`
      : sql`AND (
          candidate.created > ${rootCursor.created}
          OR (candidate.created = ${rootCursor.created} AND candidate.coid > ${rootCursor.coid})
        )`
    : sql``;

  const rows = await db.all<CommentRow & { hasMoreReplies: number }>(sql`
    WITH RECURSIVE selected_roots(coid) AS MATERIALIZED (
      SELECT candidate.coid
      FROM ${schema.comments} AS candidate
      WHERE candidate.cid = ${cid}
        AND candidate.status = 'approved'
        AND (
          candidate.parent = 0
          OR NOT EXISTS (
            SELECT 1
            FROM ${schema.comments} AS parent_comment
            WHERE parent_comment.coid = candidate.parent
              AND parent_comment.cid = ${cid}
              AND parent_comment.status = 'approved'
          )
        )
        ${rootCursorSql}
      ORDER BY candidate.created ${orderSql}, candidate.coid ${coidOrderSql}
      LIMIT ${pageSize}
    ),
    thread(coid, depth) AS (
      SELECT comment.coid, 0
      FROM ${schema.comments} AS comment
      INNER JOIN selected_roots AS root ON root.coid = comment.coid
      UNION ALL
      SELECT child.coid, parent_comment.depth + 1
      FROM thread AS parent_comment
      INNER JOIN ${schema.comments} AS child ON child.coid IN (
        SELECT reply.coid FROM ${schema.comments} AS reply
        WHERE reply.cid = ${cid} AND reply.status = 'approved'
          AND reply.parent = parent_comment.coid
        ORDER BY reply.created ${orderSql}, reply.coid ${coidOrderSql}
        LIMIT ${THREAD_PREVIEW_REPLIES_PER_PARENT}
      )
      -- Breadth first so the budget admits every selected root before replies.
      ORDER BY 2
      LIMIT ${COMMENT_UNPAGED_MAX}
    )
    SELECT comment.*, EXISTS (
      SELECT 1 FROM ${schema.comments} AS child
      WHERE child.cid = ${cid} AND child.status = 'approved'
        AND child.parent = comment.coid AND child.coid NOT IN (SELECT coid FROM thread)
    ) AS hasMoreReplies
    FROM thread
    INNER JOIN ${schema.comments} AS comment ON comment.coid = thread.coid
    ORDER BY comment.created ${orderSql}, comment.coid ${coidOrderSql}
  `);
  return {
    rows,
    pagination,
    replyLinks: Object.fromEntries(rows.filter(row => row.hasMoreReplies)
      .map(row => [row.coid, replyPageUrl(commentUrl, row.coid)])),
  };
}
