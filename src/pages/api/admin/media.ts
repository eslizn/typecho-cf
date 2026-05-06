import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { deleteFromR2 } from '@/lib/upload';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'update';
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);

  if (!cid) return new Response('Bad Request', { status: 400 });

  const attachment = await auth.db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });

  if (!attachment || attachment.type !== 'attachment') {
    return new Response('Not Found', { status: 404 });
  }

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  if (!isAdmin && attachment.authorId !== auth.uid) {
    return new Response('Forbidden', { status: 403 });
  }

  if (action === 'delete') {
    // Delete from R2
    try {
      const meta = JSON.parse(attachment.text || '{}');
      if (meta.path) {
        const bucket = env.BUCKET;
        await deleteFromR2(bucket, meta.path);
      }
    } catch {
      // Ignore R2 errors
    }

    // Delete DB record
    await auth.db.delete(schema.contents).where(eq(schema.contents.cid, cid));

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/manage-medias' },
    });
  }

  // Update attachment
  const name = formData.get('name')?.toString()?.trim() || attachment.title;
  const slug = formData.get('slug')?.toString()?.trim() || attachment.slug;

  if (action !== 'update') return new Response('Invalid action', { status: 400 });

  await auth.db.update(schema.contents).set({
    title: name,
    slug,
    modified: Math.floor(Date.now() / 1000),
  }).where(eq(schema.contents.cid, cid));

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/media?cid=${cid}` },
  });
};
