import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { deleteFromR2 } from '@/lib/upload';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'editor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'update';
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);

  if (!cid) return new Response('Bad Request', { status: 400 });

  const attachment = await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });

  if (!attachment || attachment.type !== 'attachment') {
    return new Response('Not Found', { status: 404 });
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
    await db.delete(schema.contents).where(eq(schema.contents.cid, cid));

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/manage-medias' },
    });
  }

  // Update attachment
  const name = formData.get('name')?.toString()?.trim() || attachment.title;
  const slug = formData.get('slug')?.toString()?.trim() || attachment.slug;

  await db.update(schema.contents).set({
    title: name,
    slug,
    modified: Math.floor(Date.now() / 1000),
  }).where(eq(schema.contents.cid, cid));

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/media?cid=${cid}` },
  });
};
