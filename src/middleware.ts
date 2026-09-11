import { defineMiddleware } from 'astro:middleware';
import { schema } from '@/db';
import { applyFilter, doHook, isPluginAdminPath, isPluginRoute } from '@/lib/plugin';
import { hasAuthCookies } from '@/lib/auth';
import { createAdminErrorRedirect, getAdminUserForFlash, isAdminHtmlFormRequest, adminFallbackForApiPath } from '@/lib/admin-flash';
import { compilePermalinkPattern, DEFAULT_PERMALINK_PATTERNS } from '@/lib/permalink-pattern';
import {
  bootstrapRequestCore,
  finalizeRequestResponse,
  resolveRequestTarget,
} from '@/lib/request-bootstrap';
import { eq, and, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { isCacheablePublicPath, normalizeCacheKeyUrl } from '@/lib/cache';
import { CONTENT_ROUTE_PATHS, isContentPathAllowed } from '@/lib/content-path';
import type { I18nMessage } from '@/lib/i18n';
import { i18nMessage, normalizeI18nMessage } from '@/lib/i18n';
import { getThemeTranslationCatalogVersion } from '@/lib/theme';

// Plugin loader registration (generated at build time by plugin-loader.ts).
// Statically imported so the lazy plugin loader table exists before the first
// request of a cold isolate runs setActivatedPlugins. Vitest resolves this to
// a stub that mirrors the generated registry.
import 'virtual:typecho-plugin-registry';

// Routes that must never enter the permalink-rewrite branch (rewrite targets
// plus fixed public surfaces). Note: /archives/{cid}/ is the default post
// URL *form*, not a route — the middleware re-writes it (and any custom
// post/page pattern) to the /contents/{cid}/ entry below. CONTENT_ROUTE_PATHS
// still knows the /archives/ form so the whitelist can deprecate it once a
// custom post pattern is configured.
const BUILT_IN_ROUTES = [
  /^\/contents\/\d+\/?$/,       // unified content entry (post/page rewrite target)
  /^\/category\/[^/]+\/?$/,     // category default form + rewrite target
  /^\/tag\//,
  /^\/author\//,
  /^\/search\//,
  /^\/$/,
  /^\/sitemap\.xml$/,           // SEO
  /^\/robots\.txt$/,            // SEO
  /^\/feed\/?$/,                // main feed
  /^\/feed\//,                  // sub feeds (atom, rss, comments)
];

export const onRequest = defineMiddleware(async (context, next) => {
  const target = resolveRequestTarget(context.request, context.locals);
  const { originalPath, effectivePath: path } = target;
  const url = target.effectiveUrl;

  // Skip middleware for static assets, install page, and install API
  if (
    path.startsWith('/css/') ||
    path.startsWith('/js/') ||
    path.startsWith('/img/') ||
    path.startsWith('/themes/') ||
    path.startsWith('/vendor/') ||
    path.startsWith('/plugin-assets/') ||
    path.startsWith('/usr/uploads/') ||
    path === '/install' ||
    path === '/api/install'
  ) {
    return await finalizeRequestResponse(await next(), { request: context.request });
  }

  const bootstrap = await bootstrapRequestCore(context.request, context.locals, {
    executionContext: context.locals.cfContext,
  });
  if (!bootstrap.ok) {
    return finalizeRequestResponse(bootstrap.response, { request: context.request });
  }
  const { db, options, pluginCtx, i18n, resolvedLocale, autoLocale } = bootstrap.core;

  // Fixed system surfaces claim their paths before cache lookup and plugin
  // dispatch. This keeps route-priority decisions consistent across layers.
  const isBuiltInRoute = BUILT_IN_ROUTES.some((re) => re.test(path));

  // ── Edge Cache Layer ──────────────────────────────────────────────────────
  const isGetRequest = context.request.method === 'GET';
  const hasAuth = hasAuthCookies(context.request.headers.get('cookie'));
  const isCacheable =
    options.cacheEnabled &&
    isGetRequest &&
    !hasAuth &&
    // path is the pagination-normalized effective path. The cacheable URL
    // space follows the admin permalink settings (post/page/category) plus
    // the fixed public surfaces; admin/api/usr are guarded inside the policy.
    // Internal permalink rewrite targets are never cached: the canonical
    // (configured) URL owns the cache entry, and caching the rewritten
    // built-in URL would change direct-hit semantics (e.g. page content
    // served under the post URL space instead of 302/canonical). Plugin
    // routes are never cached either — they carry their own auth and the
    // cache layer must not bypass it.
    !context.locals._permalinkRewrite &&
    !isPluginRoute(path, pluginCtx.routeClaims) &&
    isCacheablePublicPath(path, options);

  // Reuse a single Request for both cache.match and cache.put
  // Plugin activation has already completed in bootstrap. The locale and
  // catalog bundle must be known before the first cache lookup so plugin
  // overrides cannot be bypassed by a core-only cache hit.
  const cacheBundleName = `${resolvedLocale.bundleName}+${getThemeTranslationCatalogVersion(options.theme || 'typecho-theme-minimal')}`;
  const cacheKey = isCacheable
    ? new Request(withCacheVersion(context.request.url, options.cacheVersion, cacheBundleName), {
      method: 'GET',
      headers: { 'Accept-Language': cacheBundleName },
    })
    : null;

  // ── Permalink URL Rewriting ────────────────────────────────────────────────
  // After a rewrite the middleware runs again on the NEW path.
  // To avoid infinite loops, skip rewriting for paths that already
  // match an Astro built-in route (the rewrite targets).
  const postPattern = options.permalinkPattern as string | undefined;
  const pagePattern = options.pagePattern as string | undefined;
  const categoryPattern = options.categoryPattern as string | undefined;

  let permalinkTarget: string | undefined;

  if (
    !isBuiltInRoute &&
    !context.locals._permalinkRewrite &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/feed') &&
    !path.startsWith('/usr/')
  ) {
    // ── Post permalink rewriting ──
    // The default pattern matches the default URL *form* (/archives/{cid}/),
    // which is not a built-in route: BUILT_IN_ROUTES above only lists the
    // rewrite targets. Both default-form and custom-pattern URLs land here and
    // are re-written to /contents/{cid}/.
    const postRegex = compilePermalinkPattern(postPattern ?? DEFAULT_PERMALINK_PATTERNS.post, 'post');
    if (postRegex) {
      const match = path.match(postRegex);
      if (match?.groups) {
        let cid: number | null = null;

        if (match.groups.cid) {
          cid = parseInt(match.groups.cid, 10);
        } else if (match.groups.slug) {
          // Drafts keep the same custom URL as published posts; visibility
          // (author-only for drafts) is enforced by the route layer.
          const row = await db.query.contents.findFirst({
            columns: { cid: true },
            where: and(
              eq(schema.contents.slug, match.groups.slug),
              inArray(schema.contents.type, ['post', 'post_draft']),
            ),
          });
          if (row) {
            cid = row.cid;
          }
        }

        if (cid) {
          permalinkTarget = `/contents/${cid}/${url.search}`;
        }
      }
    }

    // ── Page permalink rewriting ──
    // Pages rewrite to the same article route as posts; the route layer
    // dispatches by type and enforces visibility (author-only for drafts).
    // First claim wins: when patterns overlap across kinds (e.g. page and
    // category share a URL shape), an earlier branch already resolved the
    // path and must not be overridden.
    if (!permalinkTarget) {
      const pageRegex = compilePermalinkPattern(pagePattern ?? DEFAULT_PERMALINK_PATTERNS.page, 'page');
      if (pageRegex) {
        const match = path.match(pageRegex);
        if (match?.groups) {
          let cid: number | null = null;

          if (match.groups.cid) {
            cid = parseInt(match.groups.cid, 10);
          } else if (match.groups.slug) {
            const row = await db.query.contents.findFirst({
              columns: { cid: true },
              where: and(
                eq(schema.contents.slug, match.groups.slug),
                inArray(schema.contents.type, ['page', 'page_draft']),
              ),
            });
            if (row) {
              cid = row.cid;
            }
          }

          if (cid) {
            permalinkTarget = `/contents/${cid}/${url.search}`;
          }
        }
      }
    }

    // ── Category permalink rewriting ──
    // Category slugs live in the metas namespace, so a category can share a
    // slug with a page/post; the guard keeps the earlier branch's claim when
    // the category pattern overlaps a post/page pattern.
    if (!permalinkTarget) {
      const categoryRegex = compilePermalinkPattern(categoryPattern ?? DEFAULT_PERMALINK_PATTERNS.category, 'category');
      if (categoryRegex) {
        const match = path.match(categoryRegex);
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
            permalinkTarget = `/category/${slug}/${url.search}`;
          }
        }
      }
    }
  }

  // ── Plugin route table ────────────────────────────────────────────────────
  // Only paths the system route table did NOT claim reach request:route
  // (priority: system fixed > system routes > plugin routes). permalinkTarget
  // is resolved above, so a plugin can never shadow a configured permalink
  // URL: once a system route claims the path, request:route is skipped. The
  // same applies to fixed built-in surfaces, reserved core paths, and the
  // internal rewrite target (locals._permalinkRewrite is set on the second
  // middleware pass), so plugins cannot hijack core routes. Registered plugin
  // admin paths remain eligible because isReservedCorePath() explicitly
  // allows them through.
  if (
    !permalinkTarget &&
    !context.locals._permalinkRewrite &&
    !isBuiltInRoute &&
    !isReservedCorePath(path)
  ) {
    const pluginRoute = await applyFilter(pluginCtx, 'request:route', { handled: false }, {
      request: context.request,
      url,
      path,
      originalPath,
      effectivePath: path,
      db,
      options,
      env,
      i18n,
      resolvedLocale,
    });
    if (pluginRoute?.handled && pluginRoute.response instanceof Response) {
      return await finalizeRequestResponse(pluginRoute.response, {
        request: context.request,
        pluginCtx,
        i18n,
        resolvedLocale,
        autoLocale,
      });
    }
  }

  // ── Content path whitelist ───────────────────────────────────────────────
  // Content-shaped URLs (default URL forms + the unified content entry) are
  // served only while they match the configured permalink patterns; once a
  // custom pattern is set, the old default URLs hard-404. Non-content paths
  // pass through (isContentPathAllowed returns true for them). Plugin routes
  // are exempt via the request-local route snapshot: request:route above already resolved
  // plugin paths (lazily registering configurable entry points), and a bare
  // plugin slug must not be mistaken for a deprecated default page form.
  // Internal rewrites mark the request with locals._permalinkRewrite
  // (preserved across the rewrite) so the rewrite target itself is not
  // rejected.
  if (
    !context.locals._permalinkRewrite &&
    !isPluginRoute(path, pluginCtx.routeClaims) &&
    !isContentPathAllowed(path, { permalinkPattern: postPattern, pagePattern, categoryPattern })
  ) {
    return finalizeRequestResponse(new Response(i18n.t('core.error.notFound', {}, 'Not Found'), { status: 404 }), {
      request: context.request,
      pluginCtx,
      i18n,
      resolvedLocale,
      autoLocale,
    });
  }

  if (cacheKey) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return await finalizeRequestResponse(cached, {
        request: context.request,
        pluginCtx,
        i18n,
        resolvedLocale,
        autoLocale,
      });
    }
  }

  const shouldRunArchiveRenderHooks = isFrontendDocumentRequest(context.request, path)
    && !isPluginRoute(path, pluginCtx.routeClaims);
  const archiveRenderContext = {
    request: context.request,
    requestUrl: context.request.url,
    path,
    options,
    pluginCtx,
    i18n,
    resolvedLocale,
  };
  if (shouldRunArchiveRenderHooks) {
    await doHook(pluginCtx, 'archive:beforeRender', archiveRenderContext);
  }

  // Execute the route handler
  let response: Response;
  try {
    if (permalinkTarget) {
      context.locals._permalinkRewrite = true;
      // Original path that triggered the rewrite; contents/[cid].astro uses
      // it to tell "canonical custom-pattern URL" from "deprecated default
      // URL" before deciding on a canonical redirect.
      context.locals._permalinkSourcePath = path;
    }
    const internalTarget = permalinkTarget || target.routeTarget;
    response = internalTarget ? await next(internalTarget) : await next();
  } catch (err) {
    console.error({ event: 'route_handler_failed', path, error: err instanceof Error ? err.message : String(err) });
    response = new Response(i18n.t('core.error.server', {}, 'Server error'), { status: 500 });
  }
  if (response.status === 404) {
    // Only warn for admin paths (should never 404); info for everything else
    // (bots hitting non-existent routes is normal traffic noise).
    if (path.startsWith('/admin')) {
      console.warn({ event: 'admin_route_not_found', path, method: context.request.method });
    }
  }

  // Native admin forms submit directly to API routes. Convert their error
  // responses into a safe redirect with a one-time flash instead of leaving
  // the browser on an unstyled/blank API response. JSON and AJAX callers keep
  // the original machine-readable response.
  if (isAdminHtmlFormRequest(context.request) && path.startsWith('/api/admin/') && response.status >= 400) {
    const uid = await getAdminUserForFlash(context.request, db, options);
    if (uid) {
      let message: string | I18nMessage = response.status >= 500
        ? i18nMessage('admin.error.operationFailed', 'Operation failed')
        : i18nMessage('admin.error.invalidRequest', 'Invalid request');
      try {
        const body = await response.clone().text();
        let hasHeaderDescriptor = false;
        const responseCode = response.headers.get('X-Typecho-I18n-Code');
        const responseParams = response.headers.get('X-Typecho-I18n-Params');
        if (responseCode) {
          let variables: unknown;
          try { variables = responseParams ? JSON.parse(responseParams) : undefined; } catch { variables = undefined; }
          const descriptor = normalizeI18nMessage({
            key: responseCode,
            variables,
            fallbackText: body.trim() || undefined,
          });
          if (descriptor) {
            message = descriptor;
            hasHeaderDescriptor = true;
          }
        }
        if (body.trim()) {
          try {
            const parsed = JSON.parse(body) as { error?: unknown; code?: unknown; params?: unknown };
            if (typeof parsed.code === 'string') {
              const descriptor = normalizeI18nMessage({
                key: parsed.code,
                variables: parsed.params,
                fallbackText: typeof parsed.error === 'string' ? parsed.error : undefined,
              });
              if (descriptor) message = descriptor;
            } else if (typeof parsed.error === 'string') {
              message = parsed.error;
            }
          } catch {
            if (!hasHeaderDescriptor) message = body.trim();
          }
        }
      } catch { /* preserve generic message */ }
      response = await createAdminErrorRedirect(
        context.request,
        options,
        uid,
        message,
        adminFallbackForApiPath(path),
      );
    }
  }

  if (shouldRunArchiveRenderHooks) {
    await doHook(pluginCtx, 'archive:afterRender', { ...archiveRenderContext, response });
  }

  return finalizeRequestResponse(response, {
    request: context.request,
    pluginCtx,
    cacheKey,
    executionContext: context.locals.cfContext,
    i18n,
    resolvedLocale,
    autoLocale,
  });
});

/**
 * Paths that plugins MUST NOT be able to claim via request:route.
 * Hard-coded so a misbehaving plugin can never shadow the install
 * flow, login, or admin endpoints.
 */
function isReservedCorePath(path: string): boolean {
  // Allow plugins to claim specific admin paths (registered via registerPluginAdminPath)
  if (isPluginAdminPath(path)) return false;
  if (path === '/install' || path === '/api/install') return true;
  if (path === '/admin' || path.startsWith('/admin/')) return true;
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return true;
  if (path === '/api/users/login' || path === '/api/users/logout' || path === '/api/users/register') return true;
  return false;
}

function withCacheVersion(requestUrl: string, cacheVersion?: number, bundleName?: string): string {
  const url = normalizeCacheKeyUrl(requestUrl);
  url.searchParams.set('__typecho_cache', String(cacheVersion || 0));
  if (bundleName) url.searchParams.set('__typecho_i18n', bundleName);
  return url.toString();
}

function isFrontendDocumentRequest(request: Request, path: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (
    path === '/install' ||
    path === '/sitemap.xml' ||
    path === '/robots.txt' ||
    path.startsWith('/admin') ||
    path.startsWith('/api/') ||
    path.startsWith('/feed') ||
    path.startsWith('/usr/')
  ) return false;
  const accept = request.headers.get('accept');
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}
