/**
 * Sidebar data loader
 * Aggregates recent posts, comments, categories, and archives
 * Uses db.batch() to execute all queries in a single D1 round-trip.
 */
import { eq, desc, and, gt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { buildPermalink, buildCategoryLink, buildDateLink } from '@/lib/content';
import { applyFilterSafely, type HookContext } from '@/lib/plugin';
import { publishedPostCondition, nowSeconds } from '@/lib/content-visibility';

type SidebarDatabase = Pick<Database, 'batch' | 'select'>;
// Snapshots are version-keyed, so content/options writes invalidate them by
// changing the key. A longer TTL mainly protects logged-in/cache-bypassed page
// views from repeatedly rebuilding identical global chrome data.
const SIDEBAR_SNAPSHOT_TTL_MS = 300_000;

// The monthly archives widget only scans this many seconds of history. Old
// months drop out of the sidebar widget (the posts themselves stay online),
// which bounds the GROUP BY scan on large sites.
const SIDEBAR_ARCHIVE_WINDOW_SECONDS = 13 * 30 * 24 * 3600;

export interface SidebarData {
  recentPosts: Array<{ title: string; permalink: string }>;
  recentComments: Array<{ author: string; excerpt: string; permalink: string }>;
  categories: Array<{ name: string; slug: string; count: number; permalink: string }>;
  archives: Array<{ date: string; permalink: string }>;
}

type SidebarSnapshot = { key: string; expiresAt: number; data: SidebarData };
type NavPage = { title: string; slug: string; permalink: string };
type NavSnapshot = { key: string; expiresAt: number; data: NavPage[] };
// Isolate-level snapshots (not WeakMap-by-db): getDb() yields a fresh handle
// each request, so Database-keyed WeakMaps never reuse across requests.
let sidebarSnapshot: SidebarSnapshot | null = null;
let navSnapshot: NavSnapshot | null = null;

/** Test-only: clear isolate sidebar/nav snapshots. */
export function resetSidebarSnapshots(): void {
  sidebarSnapshot = null;
  navSnapshot = null;
}

function cloneSidebarData(data: SidebarData): SidebarData {
  return {
    recentPosts: data.recentPosts.map(item => ({ ...item })),
    recentComments: data.recentComments.map(item => ({ ...item })),
    categories: data.categories.map(item => ({ ...item })),
    archives: data.archives.map(item => ({ ...item })),
  };
}

export async function loadSidebarData(
  ctx: HookContext,
  db: SidebarDatabase,
  siteUrl: string,
  permalinkPattern?: string | null,
  categoryPattern?: string | null,
  pagePattern?: string | null,
  cacheVersion: string | number = 0,
  bundleName = '',
): Promise<SidebarData> {
  const cacheKey = `${cacheVersion}\0${bundleName}\0${siteUrl}\0${permalinkPattern || ''}\0${categoryPattern || ''}\0${pagePattern || ''}`;
  const cached = sidebarSnapshot;
  if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) {
    return await applyFilterSafely(
      ctx,
      'sidebar:data',
      cloneSidebarData(cached.data),
      db,
      siteUrl,
      { capabilityRuntime: ctx.capabilityRuntime },
    );
  }

  // Execute all 4 queries in a single D1 round-trip
  const now = nowSeconds();
  const [recentPostRows, recentCommentRows, categoryRows, archiveRows] = await db.batch([
    // Recent posts
    db
      .select({
        cid: schema.contents.cid,
        title: schema.contents.title,
        slug: schema.contents.slug,
        type: schema.contents.type,
        created: schema.contents.created,
      })
      .from(schema.contents)
      .where(publishedPostCondition())
      .orderBy(desc(schema.contents.created))
      .limit(10),

    // Recent comments — only need a short preview, not the whole body.
    // Join contents so comment permalinks follow the configured patterns.
    db
      .select({
        coid: schema.comments.coid,
        cid: schema.comments.cid,
        author: schema.comments.author,
        text: sql<string>`substr(${schema.comments.text}, 1, 200)`,
        contentSlug: schema.contents.slug,
        contentType: schema.contents.type,
        contentCreated: schema.contents.created,
      })
      .from(schema.comments)
      .innerJoin(schema.contents, eq(schema.comments.cid, schema.contents.cid))
      // An approved comment must still belong to publicly visible content:
      // a post that was unpublished, made private, or rescheduled would
      // otherwise keep leaking its comment author/excerpt/permalinks into
      // every page's sidebar.
      .where(and(
        eq(schema.comments.status, 'approved'),
        or(
          publishedPostCondition(now),
          and(
            eq(schema.contents.type, 'page'),
            eq(schema.contents.status, 'publish'),
            lte(schema.contents.created, now),
          ),
        ),
      ))
      .orderBy(desc(schema.comments.created))
      .limit(10),

    // Categories
    db
      .select({
        name: schema.metas.name,
        slug: schema.metas.slug,
        count: schema.metas.count,
        order: schema.metas.order,
      })
      .from(schema.metas)
      .where(eq(schema.metas.type, 'category'))
      .orderBy(schema.metas.order),

    // Archives (by month)
    // Bound the scan to the recent window — strftime() cannot use the
    // (type, status, created) index for grouping, so this would otherwise
    // read every published row on each snapshot rebuild.
    db
      .select({
        year: sql<number>`cast(strftime('%Y', ${schema.contents.created}, 'unixepoch') as integer)`,
        month: sql<number>`cast(strftime('%m', ${schema.contents.created}, 'unixepoch') as integer)`,
      })
      .from(schema.contents)
      .where(and(
        publishedPostCondition(nowSeconds()),
        gt(schema.contents.created, nowSeconds() - SIDEBAR_ARCHIVE_WINDOW_SECONDS),
      ))
      .groupBy(
        sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`,
        sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`,
      )
      .orderBy(desc(sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`), desc(sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`)),
  ] as const);

  const recentPosts = recentPostRows.map((p) => ({
    title: p.title || ctx.i18n?.t('core.content.untitled', {}, 'Untitled') || 'Untitled',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      permalinkPattern,
    ),
  }));

  const recentComments = recentCommentRows.map((c) => ({
    author: c.author || ctx.i18n?.t('core.comment.anonymous', {}, 'Anonymous') || 'Anonymous',
    excerpt: (c.text || '').replace(/<[^>]+>/g, '').substring(0, 35) + (c.text && c.text.length > 35 ? '...' : ''),
    permalink: `${buildPermalink(
      { cid: c.cid ?? 0, slug: c.contentSlug, type: c.contentType, created: c.contentCreated },
      siteUrl,
      permalinkPattern,
      pagePattern,
    )}#comment-${c.coid}`,
  }));

  const categories = categoryRows.map((c) => ({
    name: c.name || '',
    slug: c.slug || '',
    count: c.count || 0,
    permalink: buildCategoryLink(c.slug || '', siteUrl, categoryPattern),
  }));

  const archives = archiveRows.map((a) => ({
    date: formatArchiveMonth(a.year, a.month, ctx.i18n?.locale || 'en'),
    permalink: buildDateLink(a.year, a.month, undefined, siteUrl),
  }));

  const sidebarData = { recentPosts, recentComments, categories, archives };
  sidebarSnapshot = {
    key: cacheKey,
    expiresAt: Date.now() + SIDEBAR_SNAPSHOT_TTL_MS,
    data: sidebarData,
  };

  // Apply sidebar:data filter — plugins can add/modify sidebar widgets
  return await applyFilterSafely(
    ctx,
    'sidebar:data',
    cloneSidebarData(sidebarData),
    db,
    siteUrl,
    { capabilityRuntime: ctx.capabilityRuntime },
  );
}

/**
 * Load navigation pages (published pages for header nav)
 */
export async function loadNavPages(
  db: SidebarDatabase,
  siteUrl: string,
  pagePattern?: string | null,
  cacheVersion: string | number = 0,
  i18n?: HookContext['i18n'],
  bundleName = '',
): Promise<NavPage[]> {
  const cacheKey = `${cacheVersion}\0${bundleName}\0${siteUrl}\0${pagePattern || ''}`;
  const cached = navSnapshot;
  if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) {
    return cached.data.map(item => ({ ...item }));
  }

  const rows = await db
    .select({
      cid: schema.contents.cid,
      title: schema.contents.title,
      slug: schema.contents.slug,
      type: schema.contents.type,
      created: schema.contents.created,
      order: schema.contents.order,
    })
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'page'),
        eq(schema.contents.status, 'publish'),
        lte(schema.contents.created, nowSeconds())
      )
    )
    .orderBy(schema.contents.order);

  const pages = rows.map((p) => ({
    title: p.title || i18n?.t('core.content.untitled', {}, 'Untitled') || 'Untitled',
    slug: p.slug || '',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      undefined,
      pagePattern,
    ),
  }));
  navSnapshot = {
    key: cacheKey,
    expiresAt: Date.now() + SIDEBAR_SNAPSHOT_TTL_MS,
    data: pages,
  };
  return pages.map(item => ({ ...item }));
}

function formatArchiveMonth(year: number, month: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, 1)));
  } catch {
    return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, 1)));
  }
}
