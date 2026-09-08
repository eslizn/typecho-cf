/**
 * Request context - initializes DB, options, and user for each request
 * Equivalent to Typecho's Widget\Init bootstrap
 */

import { getDb, type Database } from '@/db';
import { loadOptions, type SiteOptions, computeUrls } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission, generateSecurityToken } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, doHook, type HookContext } from '@/lib/plugin';
import { getThemePreviewId, THEME_PREVIEW_OPTION } from '@/lib/theme-preview';
import { schema } from '@/db';
import { env } from 'cloudflare:workers';
import { createRequestI18n, type RequestI18nRuntime } from '@/lib/i18n-runtime';
import type { I18n, ResolvedLocale } from '@/lib/i18n';
export { getClientIp } from '@/lib/client-ip';

/** Drizzle-inferred user row type */
export type UserRow = typeof schema.users.$inferSelect;

export interface RequestContext extends HookContext {
  db: Database;
  options: SiteOptions;
  urls: ReturnType<typeof computeUrls>;
  user: UserRow | null;
  isLoggedIn: boolean;
  csrfToken: string | null;
  i18n: I18n;
  resolvedLocale: ResolvedLocale;
  autoLocale: boolean;
}

export interface RequestCoreContext {
  db: Database;
  options: SiteOptions;
  pluginCtx: HookContext;
  i18n: I18n;
  resolvedLocale: ResolvedLocale;
  autoLocale: boolean;
}

type InternalLocals = App.Locals & {
  _typechoCore?: RequestCoreContext;
  _typechoContext?: Promise<RequestContext>;
};

const requestCores = new WeakMap<Request, RequestCoreContext>();

/** Share the middleware bootstrap with page/layout context creation. */
export function setRequestCoreContext(
  locals: App.Locals,
  core: RequestCoreContext,
  request?: Request,
): void {
  (locals as InternalLocals)._typechoCore = core;
  if (request) requestCores.set(request, core);
}

export function getRequestCoreContext(request: Request): RequestCoreContext | undefined {
  return requestCores.get(request);
}

export function getRequestCoreContextFromLocals(locals: App.Locals): RequestCoreContext | undefined {
  return (locals as InternalLocals)._typechoCore;
}

/** Resolve a translator for API routes that may be invoked without middleware
 * (for example, isolated endpoint tests or direct adapter calls). */
export function getRequestI18n(
  request: Request,
  options: SiteOptions,
  activePluginIds: Iterable<string> = [],
): I18n {
  const core = getRequestCoreContext(request);
  if (core) return core.i18n;
  return createRequestI18n(
    typeof options.lang === 'string' ? options.lang : 'zh_CN',
    request,
    activePluginIds,
  ).i18n;
}

/**
 * Create request context from Astro locals
 */
export function createContext(locals: App.Locals, request: Request): Promise<RequestContext> {
  const internalLocals = locals as InternalLocals;
  if (internalLocals._typechoContext) return internalLocals._typechoContext;

  const pending = buildContext(internalLocals, request);
  internalLocals._typechoContext = pending;
  void pending.catch(() => {
    // A transient bootstrap failure must not poison subsequent attempts made
    // by the same request pipeline.
    if (internalLocals._typechoContext === pending) {
      delete internalLocals._typechoContext;
    }
  });
  return pending;
}

/**
 * Start a route-specific read alongside authentication using the DB core that
 * middleware already installed. The fallback preserves direct test/dev calls
 * where middleware locals are unavailable.
 */
export async function createContextAlongside<T>(
  locals: App.Locals,
  request: Request,
  load: (db: Database) => Promise<T>,
): Promise<[RequestContext, T]> {
  const contextPromise = createContext(locals, request);
  const core = getRequestCoreContextFromLocals(locals);
  const valuePromise = core ? load(core.db) : contextPromise.then(ctx => load(ctx.db));
  return Promise.all([contextPromise, valuePromise]);
}

async function buildContext(locals: InternalLocals, request: Request): Promise<RequestContext> {
  const core = locals._typechoCore;
  const db = core?.db ?? getDb(env.DB);

  // Load site options
  const options = core?.options ?? await loadOptions(db);
  const urls = computeUrls(options);

  // Load activated plugins from DB options. Nothing is auto-activated: an
  // operator must explicitly turn plugins on from /admin/plugin. This means a
  // hostile package that happens to land in node_modules with typecho/plugin
  // keywords cannot register hooks without a deliberate admin action.
  const activatedIds = core
    ? []
    : parseActivatedPlugins(options.activatedPlugins as string | undefined);
  const activatedPlugins = core?.pluginCtx.activatedPlugins ?? new Set<string>();
  let runtime: RequestI18nRuntime = core
    ? {
      i18n: core.i18n,
      resolvedLocale: core.resolvedLocale,
      autoLocale: core.autoLocale,
    }
    : createRequestI18n(options.lang, request, []);
  const ctx: RequestContext = {
    db,
    options,
    urls,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
    activatedPlugins,
    i18n: runtime.i18n,
    resolvedLocale: runtime.resolvedLocale,
    autoLocale: runtime.autoLocale,
  };

  if (!core) {
    await setActivatedPlugins(ctx, activatedIds);
    runtime = createRequestI18n(options.lang, request, ctx.activatedPlugins);
    ctx.i18n = runtime.i18n;
    ctx.resolvedLocale = runtime.resolvedLocale;
    ctx.autoLocale = runtime.autoLocale;
  }

  // Check auth
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);

  if (token && options.secret) {
    const result = await validateAuthToken(token, options.secret, db);
    if (result) {
      ctx.user = result.user;
      ctx.isLoggedIn = true;
    }
  }

  const previewThemeId = getThemePreviewId(
    request,
    !!ctx.user && hasPermission(ctx.user.group || 'visitor', 'administrator'),
  );
  if (previewThemeId) {
    ctx.options = { ...ctx.options, theme: previewThemeId, [THEME_PREVIEW_OPTION]: previewThemeId };
    ctx.urls = computeUrls(ctx.options);
  }

  ctx.csrfToken = (ctx.user && options.secret)
    ? await generateSecurityToken(options.secret as string, ctx.user.authCode!, ctx.user.uid)
    : null;

  // Trigger request:begin after the request context is ready.
  await doHook(ctx, 'request:begin', ctx);

  return ctx;
}

/**
 * Require authentication - redirects to login if not authenticated
 */
export function requireAuth(ctx: RequestContext, redirectUrl?: string): Response | null {
  if (!ctx.isLoggedIn) {
    const target = redirectUrl || '/admin/login';
    return new Response(null, {
      status: 302,
      headers: { Location: target },
    });
  }
  return null;
}

/**
 * Require a specific permission level
 */
export function requirePermission(ctx: RequestContext, group: string, strict = false): Response | null {
  if (!ctx.isLoggedIn || !ctx.user) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login' },
    });
  }

  if (!hasPermission(ctx.user.group || 'visitor', group, strict)) {
    return new Response(ctx.i18n.t('core.error.forbidden', {}, 'Forbidden'), { status: 403 });
  }
  return null;
}
