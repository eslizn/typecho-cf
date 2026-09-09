import { getDb, schema, type Database } from '@/db';
import { loadOptions, type SiteOptions } from '@/lib/options';
import { getAuthCookies, hasPermission, requireAdminCSRF, validateAuthToken } from '@/lib/auth';
import { parseActivatedPlugins, setActivatedPlugins, type HookContext } from '@/lib/plugin';
import { env } from 'cloudflare:workers';
import { getRequestCoreContext } from '@/lib/context';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { assertBoundedContentLength, InputError, inputErrorResponse } from '@/lib/input';
import { createRequestI18n } from '@/lib/i18n-runtime';
import { i18nMessage, normalizeI18nMessage, type I18n, type I18nMessage } from '@/lib/i18n';
import { jsonError, textError } from '@/lib/http';

export interface AdminActionContext {
  db: Database;
  options: SiteOptions;
  uid: number;
  user: typeof schema.users.$inferSelect;
  /** Activated plugin set for firing hooks from this request. */
  pluginCtx: HookContext;
  /** Request-local translator for API and admin action messages. */
  i18n: I18n;
}

interface RequireAdminActionOptions {
  csrf?: boolean;
  /** Maximum declared request-body size, checked before CSRF body parsing. */
  maxBodyBytes?: number;
  /**
   * Load and activate the plugin set for this request. Defaults to
   * `csrf` (i.e. state-changing POST routes get plugins for free, read
   * routes stay lean). Pass `true` explicitly for GET routes that need
   * to fire hooks (e.g. plugin config listing).
   */
  plugins?: boolean;
}

/**
 * Returns true when the request's Origin/Referer matches the configured
 * site origin. Missing both headers is treated as untrusted, so naive
 * `<form enctype=text/plain>`-style cross-site POSTs are rejected even
 * if the attacker somehow guesses a CSRF token.
 *
 * If siteUrl is not yet configured (fresh install / test fixtures), we
 * fall back to permissive — there is no trust anchor to compare against.
 */
export function isSameOriginRequest(request: Request, siteUrl: string): boolean {
  if (!siteUrl) {
    const source = request.headers.get('origin') || request.headers.get('referer');
    if (!source) return false;
    try {
      return new URL(source).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  let expected = '';
  try { expected = new URL(siteUrl).origin; } catch { return false; }
  if (!expected) return false;

  const headerCheck = (raw: string | null): boolean | null => {
    if (!raw) return null;
    try { return new URL(raw).origin === expected; } catch { return false; }
  };

  const origin = headerCheck(request.headers.get('origin'));
  if (origin !== null) return origin;
  const referer = headerCheck(request.headers.get('referer'));
  if (referer !== null) return referer;
  return false;
}

export async function requireAdminAction(
  request: Request,
  requiredGroup: string,
  { csrf = true, plugins, maxBodyBytes = REQUEST_BODY_LIMITS.adminForm }: RequireAdminActionOptions = {},
): Promise<AdminActionContext | Response> {
  const requestCore = getRequestCoreContext(request);
  const db = requestCore?.db ?? getDb(env.DB);
  const options = requestCore?.options ?? await loadOptions(db);
  const errorI18n = requestCore?.i18n ?? createRequestI18n(
    typeof options.lang === 'string' ? options.lang : 'zh_CN',
    request,
    [],
  ).i18n;

  if (csrf) {
    try {
      assertBoundedContentLength(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof InputError) return inputErrorResponse(error, errorI18n);
      throw error;
    }
  }
  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) {
    return textError(401, i18nMessage('core.error.unauthorized', 'Unauthorized'), undefined, errorI18n);
  }

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth) {
    return textError(401, i18nMessage('core.error.unauthorized', 'Unauthorized'), undefined, errorI18n);
  }
  if (!hasPermission(auth.user.group || 'visitor', requiredGroup)) {
    return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, errorI18n);
  }

  if (csrf) {
    // Belt-and-braces: enforce same-origin Origin/Referer in addition to
    // the CSRF token. Even if a token is leaked, cross-site POSTs are
    // rejected at the request boundary.
    if (!isSameOriginRequest(request, options.siteUrl || '')) {
      return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, errorI18n);
    }
    const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid, errorI18n);
    if (csrfError) return csrfError;
  }

  // Activate the plugin set only when the route actually fires hooks —
  // reads (csrf=false) that don't ask for plugins skip the parse and
  // pluginInits loop entirely. Callers that DO need hooks on a GET can
  // opt in with `plugins: true`.
  const wantsPlugins = plugins ?? csrf;
  const pluginCtx: HookContext = requestCore?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (wantsPlugins && !requestCore) {
    await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));
  }

  const i18n = requestCore?.i18n ?? createRequestI18n(
    typeof options.lang === 'string' ? options.lang : 'zh_CN',
    request,
    pluginCtx.activatedPlugins,
  ).i18n;
  return { db, options, uid: auth.uid, user: auth.user, pluginCtx, i18n };
}

export function isAdminActionResponse(value: AdminActionContext | Response): value is Response {
  return value instanceof Response;
}

/** Keep admin JSON endpoints consistent when authentication fails before an
 * AdminActionContext can be returned. */
export function jsonAdminActionError(request: Request, response: Response): Response {
  const core = getRequestCoreContext(request);
  const descriptor = readResponseI18nMessage(response);
  if (descriptor) return jsonError(response.status, descriptor, undefined, core?.i18n);
  if (response.status !== 401 && response.status !== 403) return response;

  const key = response.status === 401 ? 'core.error.unauthorized' : 'core.error.forbidden';
  const fallback = response.status === 401 ? 'Unauthorized' : 'Forbidden';
  return jsonError(response.status, i18nMessage(key, fallback), undefined, core?.i18n);
}

function readResponseI18nMessage(response: Response): I18nMessage | null {
  const key = response.headers.get('X-Typecho-I18n-Code');
  if (!key) return null;

  let variables: unknown;
  const rawVariables = response.headers.get('X-Typecho-I18n-Params');
  if (rawVariables) {
    try { variables = JSON.parse(rawVariables); } catch { variables = undefined; }
  }
  return normalizeI18nMessage({ key, variables });
}

export function safeAdminRedirectUrl(referer: string | null, siteUrl: string, fallback: string): string {
  if (!referer) return fallback;
  try {
    const refUrl = new URL(referer);
    const siteOrigin = new URL(siteUrl).origin;
    if (refUrl.origin !== siteOrigin) return fallback;
    if (refUrl.pathname !== '/admin' && !refUrl.pathname.startsWith('/admin/')) return fallback;
    return `${refUrl.pathname}${refUrl.search}`;
  } catch {
    return fallback;
  }
}
