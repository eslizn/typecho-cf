import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { eq, sql } from 'drizzle-orm';
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
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-medias',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    // G4-2: bulk-fetch attachments, run R2 deletes in parallel, then
    // emit a single content delete in one round-trip.
    const attachments = await auth.db.select().from(schema.contents)
      .where(sql`${schema.contents.cid} IN (${sql.join(cids.map(id => sql`${id}`), sql`, `)})`);
    const targets = attachments.filter(a =>
      a.type === 'attachment' && (isAdmin || a.authorId === auth.uid),
    );

    if (targets.length > 0) {
      // R2 deletes in parallel — drizzle/d1 batch can't include them.
      await Promise.all(targets.map(async att => {
        try {
          const meta = JSON.parse(att.text || '{}');
          if (meta.path && env.BUCKET) {
            await env.BUCKET.delete(meta.path);
          }
        } catch { /* ignore */ }
      }));

      const idList = sql.join(targets.map(t => sql`${t.cid}`), sql`, `);
      await auth.db.delete(schema.contents).where(sql`${schema.contents.cid} IN (${idList})`);
    }
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-medias',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
