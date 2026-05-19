import { getDb, schema, type Database } from '@/db';
import { loadOptions, type SiteOptions } from '@/lib/options';
import { getAuthCookies, hasPermission, requireAdminCSRF, validateAuthToken } from '@/lib/auth';
import { env } from 'cloudflare:workers';

export interface AdminActionContext {
  db: Database;
  options: SiteOptions;
  uid: number;
  user: typeof schema.users.$inferSelect;
}

interface RequireAdminActionOptions {
  csrf?: boolean;
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
  if (!siteUrl) return true;
  let expected = '';
  try { expected = new URL(siteUrl).origin; } catch { return true; }
  if (!expected) return true;

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
  { csrf = true }: RequireAdminActionOptions = {},
): Promise<AdminActionContext | Response> {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth) return new Response('Unauthorized', { status: 401 });
  if (!hasPermission(auth.user.group || 'visitor', requiredGroup)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (csrf) {
    // Belt-and-braces: enforce same-origin Origin/Referer in addition to
    // the CSRF token. Even if a token is leaked, cross-site POSTs are
    // rejected at the request boundary.
    if (!isSameOriginRequest(request, options.siteUrl || '')) {
      return new Response('Forbidden', { status: 403 });
    }
    const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid);
    if (csrfError) return csrfError;
  }

  return { db, options, uid: auth.uid, user: auth.user };
}

export function isAdminActionResponse(value: AdminActionContext | Response): value is Response {
  return value instanceof Response;
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
