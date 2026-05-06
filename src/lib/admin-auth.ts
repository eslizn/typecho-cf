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
    const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid);
    if (csrfError) return csrfError;
  }

  return { db, options, uid: auth.uid, user: auth.user };
}

export function isAdminActionResponse(value: AdminActionContext | Response): value is Response {
  return value instanceof Response;
}
