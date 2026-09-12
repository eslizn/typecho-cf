import { env } from 'cloudflare:workers';
import { getDb } from '@/db';
import { setRequestCoreContext, type RequestCoreContext } from '@/lib/context';
import { ensureDatabaseReady, TablesMissingError } from '@/lib/isolate-boot';
import { ensureSecret, loadOptions } from '@/lib/options';
import { parsePageNumber } from '@/lib/input';
import {
  doHook,
  getPluginRouteClaimsSnapshot,
  loadPluginConfig,
  parseActivatedPlugins,
  refreshPluginRoutes,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { applySecurityHeaders } from '@/lib/security-headers';
import { createCoreRequestI18n, createRequestI18n } from '@/lib/i18n-runtime';
import type { I18n, ResolvedLocale } from '@/lib/i18n';
import { createRequestCapabilityRuntime } from '@/lib/request-capability';

export interface RequestTarget {
  originalUrl: URL;
  effectiveUrl: URL;
  originalPath: string;
  effectivePath: string;
  /** Internal Astro route target, present for Typecho pagination URLs. */
  routeTarget?: string;
}

export interface BootstrapSuccess {
  ok: true;
  core: RequestCoreContext;
}

export interface BootstrapFailure {
  ok: false;
  response: Response;
}

export type BootstrapResult = BootstrapSuccess | BootstrapFailure;

export interface ResponseFinalization {
  request: Request;
  pluginCtx?: HookContext;
  cacheKey?: Request | null;
  executionContext?: { waitUntil(promise: Promise<unknown>): void } | null;
  i18n?: I18n;
  resolvedLocale?: ResolvedLocale;
  autoLocale?: boolean;
}

// A request can pass through several early-return branches in middleware
// (plugin route, cache hit, whitelist rejection, or the normal route). Keep
// request:end exactly-once at the finalization boundary.
const finalizedRequests = new WeakSet<Request>();

/** Resolve Typecho `/page/N/` syntax without short-circuiting middleware. */
export function resolveRequestTarget(request: Request, locals: App.Locals): RequestTarget {
  const originalUrl = new URL(request.url);
  const effectiveUrl = new URL(originalUrl);
  const originalPath = originalUrl.pathname;
  const match = originalPath.match(/^(.*)\/page\/([^/]+)\/?$/);
  let routeTarget: string | undefined;

  if (match) {
    const basePath = match[1] || '';
    (locals as App.Locals & { _page?: number })._page = parsePageNumber(match[2]);
    effectiveUrl.pathname = basePath === '' ? '/' : `${basePath}/`;
    routeTarget = `${effectiveUrl.pathname}${originalUrl.search}`;
  }

  return {
    originalUrl,
    effectiveUrl,
    originalPath,
    effectivePath: effectiveUrl.pathname,
    routeTarget,
  };
}

export interface BootstrapOptions {
  executionContext?: { waitUntil(promise: Promise<unknown>): void } | null;
}

/** Initialize the database, Site Options, and activated Hook Context once. */
export async function bootstrapRequestCore(
  request: Request,
  locals: App.Locals,
  bootstrapOptions: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const d1 = env.DB;
  try {
    await ensureDatabaseReady(d1, bootstrapOptions.executionContext);
  } catch (error) {
    if (error instanceof TablesMissingError) {
      return { ok: false, response: new Response(null, { status: 302, headers: { Location: '/install' } }) };
    }
    console.error({ event: 'request_bootstrap_failed', stage: 'database_ready', error: safeError(error) });
    const runtime = createCoreRequestI18n(request);
    return { ok: false, response: new Response(runtime.i18n.t('core.error.serviceUnavailable'), { status: 500 }) };
  }

  const db = getDb(d1);
  try {
    let options = await loadOptions(db);
    if (!options.installed) {
      return { ok: false, response: new Response(null, { status: 302, headers: { Location: '/install' } }) };
    }
    if (!options.secret) {
      await ensureSecret(db);
      options = await loadOptions(db);
    }

    // Plugins are always activated before the route, cache, and capability
    // decisions below: the request-local route claims and the capability
    // runtime both derive from the activation set, and skipping activation
    // would let plugin-owned paths enter the edge cache.
    const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
    await setActivatedPlugins(
      pluginCtx,
      parseActivatedPlugins(options.activatedPlugins as string | undefined),
    );
    pluginCtx.routeResolverFailures = refreshPluginRoutes(
      pluginCtx.activatedPlugins,
      pluginId => loadPluginConfig(options, pluginId),
    );
    pluginCtx.routeClaims = getPluginRouteClaimsSnapshot();
    const runtime = createRequestI18n(
      options.lang,
      request,
      pluginCtx.activatedPlugins,
    );
    pluginCtx.i18n = runtime.i18n;
    pluginCtx.resolvedLocale = runtime.resolvedLocale;
    const capabilityRuntime = createRequestCapabilityRuntime({
      request,
      db,
      options,
      activatedPlugins: pluginCtx.activatedPlugins,
      activationGeneration: pluginCtx.activationGeneration,
    });
    pluginCtx.capabilityRuntime = capabilityRuntime;
    const core = {
      db,
      options,
      pluginCtx,
      i18n: runtime.i18n,
      resolvedLocale: runtime.resolvedLocale,
      autoLocale: runtime.autoLocale,
      capabilityRuntime,
    };
    setRequestCoreContext(locals, core, request);
    return { ok: true, core };
  } catch (error) {
    console.error({ event: 'request_bootstrap_failed', stage: 'site_options', error: safeError(error) });
    const runtime = createCoreRequestI18n(request);
    return { ok: false, response: new Response(runtime.i18n.t('core.error.serviceUnavailable', {}, 'Service unavailable'), { status: 500 }) };
  }
}

/** Apply common headers and optionally persist one safe public cache entry. */
export async function finalizeRequestResponse(
  response: Response,
  finalization: ResponseFinalization,
): Promise<Response> {
  let finalized = await applySecurityHeaders(
    response,
    { request: finalization.request, i18n: finalization.i18n },
    finalization.pluginCtx,
  );
  if (finalization.autoLocale) {
    const headers = new Headers(finalized.headers);
    headers.set('Vary', mergeVary(headers.get('Vary'), ['Accept-Language']));
    finalized = new Response(finalized.body, {
      status: finalized.status,
      statusText: finalized.statusText,
      headers,
    });
  }
  // Public HTML is cached for 5 minutes; a not-found response gets a short
  // negative TTL so a bot walking random /{slug} URLs cannot force a D1 lookup
  // (or a full page render) on every single request.
  const cacheableStatus = finalized.status === 200 || finalized.status === 404;
  if (finalization.cacheKey && cacheableStatus) {
    const isNotFound = finalized.status === 404;
    const cacheHeaders = new Headers(finalized.headers);
    if (!cacheHeaders.has('Cache-Control')) {
      cacheHeaders.set('Cache-Control', isNotFound ? 'public, s-maxage=60' : 'public, s-maxage=300');
    }
    const vary = ['Cookie', 'Accept-Encoding'];
    if (finalization.autoLocale) vary.push('Accept-Language');
    cacheHeaders.set('Vary', mergeVary(cacheHeaders.get('Vary'), vary));
    cacheHeaders.delete('Set-Cookie');
    const cacheable = new Response(finalized.clone().body, {
      status: finalized.status,
      statusText: finalized.statusText,
      headers: cacheHeaders,
    });
    const cacheWrite = caches.default.put(finalization.cacheKey, cacheable);
    if (finalization.executionContext) finalization.executionContext.waitUntil(cacheWrite);
    else await cacheWrite;
  }

  if (finalization.pluginCtx && !finalizedRequests.has(finalization.request)) {
    finalizedRequests.add(finalization.request);
    await doHook(finalization.pluginCtx, 'request:end', {
      request: finalization.request,
      response: finalized,
      i18n: finalization.i18n,
      resolvedLocale: finalization.resolvedLocale,
      capabilityRuntime: finalization.pluginCtx.capabilityRuntime,
    });
  }
  return finalized;
}

export function mergeVary(existing: string | null, additions: string[]): string {
  const tokens = new Set<string>();
  if (existing) for (const token of existing.split(',')) tokens.add(token.trim());
  for (const token of additions) tokens.add(token);
  return [...tokens].filter(Boolean).join(', ');
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
