import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { readAdminFormOrError } from '@/lib/input';
import { and, eq, sql } from 'drizzle-orm';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;

  const action = url.searchParams.get('do') || '';
  if (action !== 'delete') {
    return textError(400, i18nMessage('admin.batch.invalidAction', 'Invalid action.'), undefined, auth.i18n);
  }

  // Get selected uids from form body
  let uids: number[] = [];
  if (request.method === 'POST') {
    const formData = await readAdminFormOrError(request, undefined, auth.i18n);
    if (formData instanceof Response) return formData;
    uids = formData.getAll('uid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  if (uids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-users',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  // Keep the acting administrator outside the selection. Recheck that their
  // role is still current inside the atomic write batch, so a concurrent
  // demotion cannot leave the site without an administrator.
  const targets = [...new Set(uids)].filter(uid => uid > 0 && uid !== auth.uid);
  if (targets.length > 0) {
    const idList = sql.join(targets.map(id => sql`${id}`), sql`, `);
    const actorIsAdmin = and(eq(schema.users.uid, auth.uid), eq(schema.users.group, 'administrator'));
    const authorized = sql`EXISTS (SELECT 1 FROM ${schema.users} WHERE ${actorIsAdmin})`;
    const [actors] = await auth.db.batch([
      auth.db.select({ uid: schema.users.uid }).from(schema.users).where(actorIsAdmin),
      auth.db.update(schema.contents).set({ authorId: auth.uid })
        .where(and(sql`${schema.contents.authorId} IN (${idList})`, authorized)),
      auth.db.update(schema.comments).set({ authorId: auth.uid })
        .where(and(sql`${schema.comments.authorId} IN (${idList})`, authorized)),
      auth.db.delete(schema.users).where(and(sql`${schema.users.uid} IN (${idList})`, authorized)),
    ]);
    if (actors.length === 0) {
      return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, auth.i18n);
    }
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-users',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
