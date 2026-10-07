import { sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { loadSidebarData, loadNavPages, type SidebarData } from '@/lib/sidebar';
import { createThemeI18n, loadThemeConfig } from '@/lib/theme';
import { buildPermalink, buildCategoryLink } from '@/lib/content';
import { renderContentExcerpt } from '@/lib/markdown';
import type { RequestContext } from '@/lib/context';
import { applyFilterSafely } from '@/lib/plugin';
import { escapeHtml } from '@/lib/escape';
import { createI18n, type I18n } from '@/lib/i18n';
import { coreCatalogs } from '@/i18n/catalogs';
import type { PostListItem } from '@/lib/theme-props';

export type ContentRow = typeof schema.contents.$inferSelect;
export type CommentRow = typeof schema.comments.$inferSelect;
export type MetaRow = typeof schema.metas.$inferSelect;
export type UserRow = typeof schema.users.$inferSelect;
export type ContentTermEntry = { name: string; slug: string; permalink: string };
type CategoryEntry = ContentTermEntry;
export type CategoryMap = Map<number, CategoryEntry[]>;
type AuthorEntry = { uid: number; name: string | null; screenName: string | null };
export type AuthorMap = Map<number, AuthorEntry>;

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

export function getRequestI18n(ctx: RequestContext): I18n {
  return ctx.i18n ?? FALLBACK_I18N;
}

export function getRequestBundleName(ctx: RequestContext): string {
  return ctx.resolvedLocale?.bundleName ?? FALLBACK_BUNDLE_NAME;
}

// ─── Helpers ────────────────────────────────────────────────────────────

export async function loadCommon(ctx: RequestContext, requestUrl: string, withSidebar = true) {
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

export function getPage(locals: Record<string, unknown>, url: URL): number {
  const raw = (locals as { _page?: number })._page ?? url.searchParams.get('page');
  return raw ? (typeof raw === 'number' ? raw : parseInt(raw, 10) || 1) : 1;
}

export async function filterContentRow(
  ctx: RequestContext,
  post: ContentRow,
  stage: 'list' | 'single',
): Promise<ContentRow> {
  const filtered = await applyFilterSafely(ctx, 'content:data', { ...post }, {
    content: post,
    stage,
    capabilityRuntime: ctx.capabilityRuntime,
  });
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

export async function filterContentTitle(ctx: RequestContext, title: string, post: ContentRow): Promise<string> {
  const filtered = await applyFilterSafely(ctx, 'content:title', title, {
    content: post,
    capabilityRuntime: ctx.capabilityRuntime,
  });
  return typeof filtered === 'string' ? filtered : title;
}

export async function filterContentExcerpt(ctx: RequestContext, excerpt: string, post: ContentRow): Promise<string> {
  const filtered = await applyFilterSafely(ctx, 'content:excerpt', excerpt, {
    content: post,
    capabilityRuntime: ctx.capabilityRuntime,
  });
  return typeof filtered === 'string' ? filtered : excerpt;
}

export async function fetchAuthors(db: Database, authorIds: number[]): Promise<AuthorMap> {
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

export function mapPostCategories(
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

export async function toPostListItem(
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
