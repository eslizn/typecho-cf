import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { deleteAttachments } from '@/lib/attachment-lifecycle';
import { resolveUniqueContentSlug } from '@/lib/slug';
import { readAdminFormOrError } from '@/lib/input';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await readAdminFormOrError(request, undefined, auth.i18n);
  if (formData instanceof Response) return formData;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, auth.i18n);
  const action = formData.get('do')?.toString() || 'update';
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);

  if (!cid) return error(400, 'admin.media.badRequest', {}, 'Bad Request');

  if (action === 'delete') {
    const result = await deleteAttachments({
      db: auth.db,
      bucket: env.BUCKET,
      pluginCtx: auth.pluginCtx,
      actor: { uid: auth.uid, group: auth.user.group, user: auth.user },
      request,
      options: auth.options,
    }, [cid]);
    if (result.missing.includes(cid)) return error(404, 'admin.media.notFound', {}, 'Not Found');
    if (result.forbidden.includes(cid)) return error(403, 'admin.media.forbidden', {}, 'Forbidden');
    return new Response(null, { status: 302, headers: { Location: '/admin/manage-medias' } });
  }

  const attachment = await auth.db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });

  if (!attachment || attachment.type !== 'attachment') {
    return error(404, 'admin.media.notFound', {}, 'Not Found');
  }

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  if (!isAdmin && attachment.authorId !== auth.uid) {
    return error(403, 'admin.media.forbidden', {}, 'Forbidden');
  }

  // Update attachment
  const name = formData.get('name')?.toString()?.trim() || attachment.title;
  const slug = await resolveUniqueContentSlug(
    auth.db,
    formData.get('slug')?.toString() || attachment.slug,
    cid,
    attachment.title || String(cid),
  );

  if (action !== 'update') return error(400, 'admin.media.invalidAction', {}, 'Invalid action.');

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
