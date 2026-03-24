/**
 * Sidebar data loader
 * Aggregates recent posts, comments, categories, and archives
 */
import { eq, desc, and, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { buildPermalink, buildCategoryLink, buildDateLink } from '@/lib/content';
import { applyFilter } from '@/lib/plugin';

export interface SidebarData {
  recentPosts: Array<{ title: string; permalink: string }>;
  recentComments: Array<{ author: string; excerpt: string; permalink: string }>;
  categories: Array<{ name: string; slug: string; count: number; permalink: string }>;
  archives: Array<{ date: string; permalink: string }>;
}

export async function loadSidebarData(db: Database, siteUrl: string, permalinkPattern?: string | null, categoryPattern?: string | null): Promise<SidebarData> {
  // Recent posts
  const recentPostRows = await db
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
    .limit(10);

  const recentPosts = recentPostRows.map((p) => ({
    title: p.title || '无标题',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      permalinkPattern,
    ),
  }));

  // Recent comments
  const recentCommentRows = await db
    .select({
      coid: schema.comments.coid,
      cid: schema.comments.cid,
      author: schema.comments.author,
      text: schema.comments.text,
    })
    .from(schema.comments)
    .where(eq(schema.comments.status, 'approved'))
    .orderBy(desc(schema.comments.created))
    .limit(10);

  const recentComments = recentCommentRows.map((c) => ({
    author: c.author || '匿名',
    excerpt: (c.text || '').replace(/<[^>]+>/g, '').substring(0, 35) + (c.text && c.text.length > 35 ? '...' : ''),
    permalink: `${siteUrl.replace(/\/$/, '')}/archives/${c.cid}/#comment-${c.coid}`,
  }));

  // Categories
  const categoryRows = await db
    .select()
    .from(schema.metas)
    .where(eq(schema.metas.type, 'category'))
    .orderBy(schema.metas.order);

  const categories = categoryRows.map((c) => ({
    name: c.name || '',
    slug: c.slug || '',
    count: c.count || 0,
    permalink: buildCategoryLink(c.slug || '', siteUrl, categoryPattern),
  }));

  // Archives (by month)
  const archiveRows = await db
    .select({
      created: schema.contents.created,
    })
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish')
      )
    )
    .orderBy(desc(schema.contents.created));

  // Group by year/month
  const archiveMap = new Map<string, { year: number; month: number }>();
  for (const row of archiveRows) {
    if (!row.created) continue;
    const d = new Date(row.created * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!archiveMap.has(key)) {
      archiveMap.set(key, { year: d.getFullYear(), month: d.getMonth() + 1 });
    }
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const archives = Array.from(archiveMap.values()).map((a) => ({
    date: `${monthNames[a.month - 1]} ${a.year}`,
    permalink: buildDateLink(a.year, a.month, undefined, siteUrl),
  }));

  const sidebarData = { recentPosts, recentComments, categories, archives };

  // Apply widget:sidebar filter — plugins can add/modify sidebar widgets
  return await applyFilter('widget:sidebar', sidebarData, db, siteUrl);
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
