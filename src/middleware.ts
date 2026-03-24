import { defineMiddleware } from 'astro:middleware';
import { getDb } from '@/db';
import { schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { eq, and } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

const redirectToInstall = () =>
  new Response(null, { status: 302, headers: { Location: '/install' } });

/**
 * Build a regex from a permalink pattern to match incoming URLs.
 * Returns named capture groups for the variables.
 *
 * E.g. /archives/{slug}.html → /^\/archives\/(?<slug>[^\/]+)\.html$/
 *      /{year}/{month}/{day}/{slug}.html → /^\/(?<year>\d{4})\/(?<month>\d{2})\/(?<day>\d{2})\/(?<slug>[^\/]+)\.html$/
 */
function buildPermalinkRegex(pattern: string): RegExp | null {
  if (!pattern) return null;

  let regexStr = pattern
    // Escape dots
    .replace(/\./g, '\\.')
    // Replace variables with named capture groups
    .replace(/\{cid\}/g, '(?<cid>\\d+)')
    .replace(/\{slug\}/g, '(?<slug>[^/]+)')
    .replace(/\{mid\}/g, '(?<mid>\\d+)')
    .replace(/\{category\}/g, '(?<category>[^/]+)')
    .replace(/\{year\}/g, '(?<year>\\d{4})')
    .replace(/\{month\}/g, '(?<month>\\d{1,2})')
    .replace(/\{day\}/g, '(?<day>\\d{1,2})');

  // Handle trailing slash optionality
  if (regexStr.endsWith('/')) {
    regexStr = regexStr.slice(0, -1) + '/?';
  }

  try {
    return new RegExp(`^${regexStr}$`);
  } catch {
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
  // Extract page number, store in locals, and rewrite to the base path
  const paginationMatch = path.match(/^(.*)\/page\/(\d+)\/?$/);
  if (paginationMatch) {
    const basePath = paginationMatch[1] || '';
    const pageNum = parseInt(paginationMatch[2], 10);
    (context.locals as any)._page = pageNum;
    return context.rewrite(basePath === '' ? '/' : basePath + '/');
  }

  // Check installation status — redirect to /install if DB not ready
  const d1 = env.DB;

  // First check if the options table exists (avoids noisy D1_ERROR for missing tables)
  try {
    const tableCheck = await d1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='typecho_options'")
      .first<{ name: string }>();

    if (!tableCheck) {
      // Table doesn't exist — need installation
      return redirectToInstall();
    }
  } catch {
    return redirectToInstall();
  }

  // Table exists — check if installation is complete
  let options;
  try {
    const db = getDb(d1);
    options = await loadOptions(db);
    if (!options.installed) {
      return redirectToInstall();
    }
  } catch {
    return redirectToInstall();
  }

  // ── Permalink URL Rewriting ────────────────────────────────────────────────
  // If custom permalink patterns are set, incoming URLs need to be resolved
  // to the actual Astro routes.
  //
  // IMPORTANT: After a rewrite the middleware runs again on the NEW path.
  // To avoid infinite loops we MUST skip rewriting for paths that already
  // match an Astro built-in route (the rewrite targets):
  //   - /archives/{cid}/   (post)
  //   - /{slug}.html       (page)
  //   - /category/{slug}/  (category)
  //   - /                  (index)
  //   - /tag/…  /author/…  /search/…  (other built-ins)

  const postPattern = options.permalinkPattern as string | undefined;
  const pagePattern = options.pagePattern as string | undefined;
  const categoryPattern = options.categoryPattern as string | undefined;

  // Patterns that represent Astro built-in route shapes (rewrite targets).
  // If the current path already matches one of these, never rewrite again.
  const builtInRoutes = [
    /^\/archives\/\d+\/?$/,       // post: /archives/{cid}/
    /^\/[^/]+\.html$/,            // page: /{slug}.html
    /^\/category\/[^/]+\/?$/,     // category: /category/{slug}/
    /^\/tag\//,                   // tag pages
    /^\/author\//,                // author pages
    /^\/search\//,                // search pages
    /^\/$/,                       // index
  ];

  const isBuiltInRoute = builtInRoutes.some((re) => re.test(path));

  // Only attempt rewriting for front-end requests that aren't already on a built-in route
  if (
    !isBuiltInRoute &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/feed') &&
    !path.startsWith('/usr/')
  ) {
    const db = getDb(d1);

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
            // Pattern uses cid — look up slug from database
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
            // Pattern uses mid — look up slug from database
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

  return next();
});
