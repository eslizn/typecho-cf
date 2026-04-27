import { defineMiddleware } from 'astro:middleware';
import { getDb } from '@/db';
import { schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { eq, and } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

const redirectToInstall = () =>
  new Response(null, { status: 302, headers: { Location: '/install' } });

// ── Module-level caches (persist across requests within the same isolate) ──
const regexCache = new Map<string, RegExp | null>();

// Once we confirm the DB tables exist, skip the sqlite_master check on subsequent requests.
// Negative results are NOT cached — each request retries until installation succeeds.
let tableCheckPassed = false;

/**
 * Build a regex from a permalink pattern to match incoming URLs.
 * Returns named capture groups for the variables.
 * Results are cached in a module-level Map.
 */
function buildPermalinkRegex(pattern: string): RegExp | null {
  if (!pattern) return null;

  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  let regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\{cid\}/g, '(?<cid>\\d+)')
    .replace(/\{slug\}/g, '(?<slug>[^/]+)')
    .replace(/\{mid\}/g, '(?<mid>\\d+)')
    .replace(/\{category\}/g, '(?<category>[^/]+)')
    .replace(/\{year\}/g, '(?<year>\\d{4})')
    .replace(/\{month\}/g, '(?<month>\\d{1,2})')
    .replace(/\{day\}/g, '(?<day>\\d{1,2})');

  if (regexStr.endsWith('/')) {
    regexStr = regexStr.slice(0, -1) + '/?';
  }

  try {
    const re = new RegExp(`^${regexStr}$`);
    regexCache.set(pattern, re);
    return re;
  } catch {
    regexCache.set(pattern, null);
    return null;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Skip middleware for static assets, install page, and install API
  if (
    path.startsWith('/css/') ||
    path.startsWith('/js/') ||
    path.startsWith('/img/') ||
    path.startsWith('/themes/') ||
    path === '/install' ||
    path === '/api/install'
  ) {
    return next();
  }

  // ── Pagination URL Rewriting ──────────────────────────────────────────────
  // Typecho uses /page/N/ suffix for pagination (e.g. /page/2/, /category/default/page/2/)
  const paginationMatch = path.match(/^(.*)\/page\/(\d+)\/?$/);
  if (paginationMatch) {
    const basePath = paginationMatch[1] || '';
    const pageNum = parseInt(paginationMatch[2], 10);
    (context.locals as any)._page = pageNum;
    return context.rewrite(basePath === '' ? '/' : basePath + '/');
  }

  // Check installation status — redirect to /install if DB not ready.
  // Once tables are confirmed, skip the check for the isolate's lifetime.
  const d1 = env.DB;

  if (!tableCheckPassed) {
    try {
      const tableCheck = await d1
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='typecho_options'")
        .first<{ name: string }>();

      if (!tableCheck) {
        return redirectToInstall();
      }
      tableCheckPassed = true;
    } catch {
      return redirectToInstall();
    }
  }

  const db = getDb(d1);

  let options;
  try {
    options = await loadOptions(db);
    if (!options.installed) {
      return redirectToInstall();
    }
  } catch {
    return redirectToInstall();
  }

  // ── Edge Cache Layer ──────────────────────────────────────────────────────
  const isGetRequest = context.request.method === 'GET';
  const hasAuth = context.request.headers.get('cookie')?.includes('__typecho_uid');
  const isCacheable =
    options.cacheEnabled &&
    isGetRequest &&
    !hasAuth &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/usr/');

  // Reuse a single Request for both cache.match and cache.put
  const cacheKey = isCacheable ? new Request(context.request.url, { method: 'GET' }) : null;

  if (cacheKey) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // ── Permalink URL Rewriting ────────────────────────────────────────────────
  // After a rewrite the middleware runs again on the NEW path.
  // To avoid infinite loops, skip rewriting for paths that already
  // match an Astro built-in route (the rewrite targets).
  const postPattern = options.permalinkPattern as string | undefined;
  const pagePattern = options.pagePattern as string | undefined;
  const categoryPattern = options.categoryPattern as string | undefined;

  const builtInRoutes = [
    /^\/archives\/\d+\/?$/,       // post: /archives/{cid}/
    /^\/[^/]+\.html$/,            // page: /{slug}.html
    /^\/category\/[^/]+\/?$/,     // category: /category/{slug}/
    /^\/tag\//,
    /^\/author\//,
    /^\/search\//,
    /^\/$/,
  ];

  const isBuiltInRoute = builtInRoutes.some((re) => re.test(path));

  if (
    !isBuiltInRoute &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/feed') &&
    !path.startsWith('/usr/')
  ) {
    // ── Post permalink rewriting ──
    if (
      postPattern &&
      postPattern !== '/archives/{cid}/'
    ) {
      const regex = buildPermalinkRegex(postPattern);
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let cid: number | null = null;

          if (match.groups.cid) {
            cid = parseInt(match.groups.cid, 10);
          } else if (match.groups.slug) {
            const row = await db.query.contents.findFirst({
              columns: { cid: true },
              where: and(
                eq(schema.contents.slug, match.groups.slug),
                eq(schema.contents.type, 'post'),
                eq(schema.contents.status, 'publish'),
              ),
            });
            if (row) {
              cid = row.cid;
            }
          }

          if (cid) {
            return context.rewrite(`/archives/${cid}/`);
          }
        }
      }
    }

    // ── Page permalink rewriting ──
    if (
      pagePattern &&
      pagePattern !== '/{slug}.html'
    ) {
      const regex = buildPermalinkRegex(pagePattern);
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let slug: string | null = null;

          if (match.groups.slug) {
            slug = match.groups.slug;
          } else if (match.groups.cid) {
            const row = await db.query.contents.findFirst({
              columns: { slug: true },
              where: and(
                eq(schema.contents.cid, parseInt(match.groups.cid, 10)),
                eq(schema.contents.type, 'page'),
              ),
            });
            if (row?.slug) {
              slug = row.slug;
            }
          }

          if (slug) {
            return context.rewrite(`/${slug}.html`);
          }
        }
      }
    }

    // ── Category permalink rewriting ──
    if (
      categoryPattern &&
      categoryPattern !== '/category/{slug}/'
    ) {
      const regex = buildPermalinkRegex(categoryPattern);
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let slug: string | null = null;

          if (match.groups.slug) {
            slug = match.groups.slug;
          } else if (match.groups.mid) {
            const row = await db.query.metas.findFirst({
              columns: { slug: true },
              where: and(
                eq(schema.metas.mid, parseInt(match.groups.mid, 10)),
                eq(schema.metas.type, 'category'),
              ),
            });
            if (row?.slug) {
              slug = row.slug;
            }
          }

          if (slug) {
            return context.rewrite(`/category/${slug}/`);
          }
        }
      }
    }
  }

  // Execute the route handler
  const response = await next();

  // ── Write response to edge cache ──────────────────────────────────────────
  if (cacheKey && response.status === 200) {
    const headers = new Headers(response.headers);
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'public, s-maxage=300');
    }

    const cacheable = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });

    await caches.default.put(cacheKey, cacheable);
  }

  return response;
});
