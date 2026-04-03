import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403 });
  }

  const action = url.searchParams.get('do') || '';

  // Get selected uids from form body
  let uids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    uids = formData.getAll('uid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  if (uids.length === 0) {
    const referer = request.headers.get('referer') || '/admin/manage-users';
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    for (const uid of uids) {
      // Never allow deleting self
      if (uid === auth.uid) continue;

      const targetUser = await db.query.users.findFirst({
        where: eq(schema.users.uid, uid),
      });
      if (!targetUser) continue;

      // Re-assign content and comments to current admin user
      await db.update(schema.contents)
        .set({ authorId: auth.uid })
        .where(eq(schema.contents.authorId, uid));
      await db.update(schema.comments)
        .set({ authorId: auth.uid })
        .where(eq(schema.comments.authorId, uid));

      // Delete user
      await db.delete(schema.users).where(eq(schema.users.uid, uid));
    }
  }

  const referer = request.headers.get('referer') || '/admin/manage-users';
  return new Response(null, { status: 302, headers: { Location: referer } });
}
