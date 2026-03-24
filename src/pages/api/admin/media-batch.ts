import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = handler;
export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'editor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  const action = url.searchParams.get('do') || '';

  // Get selected cids from form body
  let cids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    cids = formData.getAll('cid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  if (cids.length === 0) {
    const referer = request.headers.get('referer') || '/admin/manage-medias';
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    for (const cid of cids) {
      const attachment = await db.query.contents.findFirst({
        where: eq(schema.contents.cid, cid),
      });
      if (!attachment) continue;
      if (attachment.type !== 'attachment') continue;
      if (!isAdmin && attachment.authorId !== auth.uid) continue;

      // Try to delete from R2 if available
      try {
        const meta = JSON.parse(attachment.text || '{}');
        if (meta.path && env.BUCKET) {
          await env.BUCKET.delete(meta.path);
        }
      } catch {
        // Ignore R2 deletion errors
      }

      await db.delete(schema.contents).where(eq(schema.contents.cid, cid));
    }
  }

  const referer = request.headers.get('referer') || '/admin/manage-medias';
  return new Response(null, { status: 302, headers: { Location: referer } });
}
