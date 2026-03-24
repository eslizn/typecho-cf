/**
 * Request context - initializes DB, options, and user for each request
 * Equivalent to Typecho's Widget\Init bootstrap
 */
import { getDb, type Database } from '@/db';
import { loadOptions, type SiteOptions, computeUrls } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, doHook } from '@/lib/plugin';
import { schema } from '@/db';
import { env } from 'cloudflare:workers';

export interface RequestContext {
  db: Database;
  options: SiteOptions;
  urls: ReturnType<typeof computeUrls>;
  user: typeof schema.users.$inferSelect | null;
  isLoggedIn: boolean;
}

/**
 * Create request context from Astro locals
 */
export async function createContext(locals: App.Locals, request: Request): Promise<RequestContext> {
  const db = getDb(env.DB);

  // Load site options
  const options = await loadOptions(db);
  const urls = computeUrls(options);

  // Load activated plugins from DB options
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  // Check auth
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  let user: typeof schema.users.$inferSelect | null = null;
  let isLoggedIn = false;

  if (token && options.secret) {
    const result = await validateAuthToken(token, options.secret, db);
    if (result) {
      user = result.user;
      isLoggedIn = true;
    }
  }

  const ctx = { db, options, urls, user, isLoggedIn };

  // Trigger system:begin hook
  await doHook('system:begin', ctx);

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
    return new Response('Forbidden', { status: 403 });
  }
  return null;
}
