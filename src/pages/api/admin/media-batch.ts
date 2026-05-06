import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  const action = url.searchParams.get('do') || '';
  if (action !== 'delete') return new Response('Invalid action', { status: 400 });

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
      const attachment = await auth.db.query.contents.findFirst({
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

      await auth.db.delete(schema.contents).where(eq(schema.contents.cid, cid));
    }
  }

  const referer = request.headers.get('referer') || '/admin/manage-medias';
  return new Response(null, { status: 302, headers: { Location: referer } });
}
