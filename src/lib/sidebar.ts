/**
 * Sidebar data loader
 * Aggregates recent posts, comments, categories, and archives
 * Uses db.batch() to execute all queries in a single D1 round-trip.
 */
import { eq, desc, and, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { buildPermalink, buildCategoryLink, buildDateLink } from '@/lib/content';
import { applyFilterSafely } from '@/lib/plugin';

export interface SidebarData {
  recentPosts: Array<{ title: string; permalink: string }>;
  recentComments: Array<{ author: string; excerpt: string; permalink: string }>;
  categories: Array<{ name: string; slug: string; count: number; permalink: string }>;
  archives: Array<{ date: string; permalink: string }>;
}

export async function loadSidebarData(db: Database, siteUrl: string, permalinkPattern?: string | null, categoryPattern?: string | null): Promise<SidebarData> {
  // Execute all 4 queries in a single D1 round-trip
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
      .where(
        and(
          eq(schema.contents.type, 'post'),
          eq(schema.contents.status, 'publish')
        )
      )
      .orderBy(desc(schema.contents.created))
      .limit(10),

    // Recent comments
    db
      .select({
        coid: schema.comments.coid,
        cid: schema.comments.cid,
        author: schema.comments.author,
        text: schema.comments.text,
      })
      .from(schema.comments)
      .where(eq(schema.comments.status, 'approved'))
      .orderBy(desc(schema.comments.created))
      .limit(10),

    // Categories
    db
      .select()
      .from(schema.metas)
      .where(eq(schema.metas.type, 'category'))
      .orderBy(schema.metas.order),

    // Archives (by month)
    db
      .select({
        year: sql<number>`cast(strftime('%Y', ${schema.contents.created}, 'unixepoch') as integer)`,
        month: sql<number>`cast(strftime('%m', ${schema.contents.created}, 'unixepoch') as integer)`,
      })
      .from(schema.contents)
      .where(
        and(
          eq(schema.contents.type, 'post'),
          eq(schema.contents.status, 'publish')
        )
      )
      .groupBy(
        sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`,
        sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`,
      )
      .orderBy(desc(sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`), desc(sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`)),
  ] as const);

  const recentPosts = recentPostRows.map((p) => ({
    title: p.title || '无标题',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      permalinkPattern,
    ),
  }));

  const recentComments = recentCommentRows.map((c) => ({
    author: c.author || '匿名',
    excerpt: (c.text || '').replace(/<[^>]+>/g, '').substring(0, 35) + (c.text && c.text.length > 35 ? '...' : ''),
    permalink: `${siteUrl.replace(/\/$/, '')}/archives/${c.cid}/#comment-${c.coid}`,
  }));

  const categories = categoryRows.map((c) => ({
    name: c.name || '',
    slug: c.slug || '',
    count: c.count || 0,
    permalink: buildCategoryLink(c.slug || '', siteUrl, categoryPattern),
  }));

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const archives = archiveRows.map((a) => ({
    date: `${monthNames[a.month - 1]} ${a.year}`,
    permalink: buildDateLink(a.year, a.month, undefined, siteUrl),
  }));

  const sidebarData = { recentPosts, recentComments, categories, archives };

  // Apply widget:sidebar filter — plugins can add/modify sidebar widgets
  return await applyFilterSafely('widget:sidebar', sidebarData, db, siteUrl);
}

/**
 * Load navigation pages (published pages for header nav)
 */
export async function loadNavPages(db: Database, siteUrl: string, pagePattern?: string | null) {
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
        eq(schema.contents.status, 'publish')
      )
    )
    .orderBy(schema.contents.order);

  return rows.map((p) => ({
    title: p.title || '无标题',
    slug: p.slug || '',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      undefined,
      pagePattern,
    ),
  }));
}
