import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { schema } from '@/db';
import { applyFilter, doHook } from '@/lib/plugin';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { validateFilteredComment, WriteFilterError } from '@/lib/write-filter';
import { readAdminFormOrError } from '@/lib/input';
import { purgeCommentModerationCache } from '@/lib/comment-moderation';

export const GET: APIRoute = async () => new Response('Method Not Allowed', { status: 405 });

export const POST: APIRoute = async ({ request, url }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;
  const form = await readAdminFormOrError(request);
  if (form instanceof Response) return form;
  const coid = Number.parseInt(form.get('coid')?.toString() || url.searchParams.get('coid') || '0', 10);
  if (!coid) return new Response('Bad Request', { status: 400 });
  const existing = await auth.db.query.comments.findFirst({ where: eq(schema.comments.coid, coid) });
  if (!existing) return new Response('Not Found', { status: 404 });

  // Keep the same live-content ownership rule used by moderation actions.
  const content = await auth.db.query.contents.findFirst({ where: eq(schema.contents.cid, existing.cid || 0) });
  if (!content) return new Response('Not Found', { status: 404 });
  const isAdmin = auth.user.group === 'administrator';
  if (!isAdmin && content.authorId !== auth.uid) return new Response('Forbidden', { status: 403 });

  const baseline = { ...existing } as Record<string, unknown>;
  const candidate = {
    ...baseline,
    author: form.get('author')?.toString()?.trim() || '',
    mail: form.get('mail')?.toString()?.trim() || '',
    url: form.get('url')?.toString()?.trim() || '',
    text: form.get('text')?.toString() || '',
  };
  if (!candidate.author || !candidate.text) return new Response('作者和内容不能为空', { status: 400 });
  let filtered: Record<string, unknown>;
  try {
    filtered = validateFilteredComment(baseline, await applyFilter(auth.pluginCtx, 'comment:beforeSave', candidate, {
      request, formData: form, db: auth.db, options: auth.options, isLoggedIn: true, editing: true,
    }));
  } catch (error) {
    if (error instanceof WriteFilterError) return new Response(error.message, { status: 400 });
    throw error;
  }
  const oldStatus = existing.status;
  await auth.db.update(schema.comments).set({
    author: filtered.author as string,
    mail: filtered.mail as string,
    url: filtered.url as string,
    text: filtered.text as string,
  }).where(eq(schema.comments.coid, coid));
  await doHook(auth.pluginCtx, 'comment:action', existing, {
    action: 'edit', oldStatus, newStatus: oldStatus, options: auth.options,
  });
  await purgeCommentModerationCache(auth.db, auth.options, existing.cid);
  return new Response(null, {
    status: 302,
    headers: { Location: safeAdminRedirectUrl(request.headers.get('referer'), auth.options.siteUrl || '', '/admin/manage-comments') },
  });
};
