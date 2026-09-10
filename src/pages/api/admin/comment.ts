import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { schema } from '@/db';
import { applyFilter, doHook } from '@/lib/plugin';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { validateFilteredComment, WriteFilterError } from '@/lib/write-filter';
import { readAdminFormOrError } from '@/lib/input';
import { purgeCommentModerationCache } from '@/lib/comment-moderation';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { i18nMessage, type I18n } from '@/lib/i18n';
import { textError } from '@/lib/http';

function methodNotAllowed(request: Request): Response {
  const i18n: I18n = createCoreRequestI18n(request).i18n;
  return textError(405, i18nMessage('core.error.methodNotAllowed', 'Method Not Allowed'), undefined, i18n);
}

export const GET: APIRoute = async ({ request }) => methodNotAllowed(request);

export const POST: APIRoute = async ({ request, url }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, auth.i18n);
  const form = await readAdminFormOrError(request, undefined, auth.i18n);
  if (form instanceof Response) return form;
  const coid = Number.parseInt(form.get('coid')?.toString() || url.searchParams.get('coid') || '0', 10);
  if (!coid) return error(400, 'core.error.badRequest', {}, 'Bad Request');
  const existing = await auth.db.query.comments.findFirst({ where: eq(schema.comments.coid, coid) });
  if (!existing) return error(404, 'core.error.notFound', {}, 'Not Found');

  // Keep the same live-content ownership rule used by moderation actions.
  const content = await auth.db.query.contents.findFirst({ where: eq(schema.contents.cid, existing.cid || 0) });
  if (!content) return error(404, 'core.error.notFound', {}, 'Not Found');
  const isAdmin = auth.user.group === 'administrator';
  if (!isAdmin && content.authorId !== auth.uid) return error(403, 'core.error.forbidden', {}, 'Forbidden');

  const baseline = { ...existing } as Record<string, unknown>;
  const candidate = {
    ...baseline,
    author: form.get('author')?.toString()?.trim() || '',
    mail: form.get('mail')?.toString()?.trim() || '',
    url: form.get('url')?.toString()?.trim() || '',
    text: form.get('text')?.toString() || '',
  };
  if (!candidate.author || !candidate.text) {
    return error(400, 'admin.comment.fieldsRequired', {}, 'Author and content are required.');
  }
  let filtered: Record<string, unknown>;
  try {
    filtered = validateFilteredComment(baseline, await applyFilter(auth.pluginCtx, 'comment:beforeSave', candidate, {
      request, formData: form, db: auth.db, options: auth.options, isLoggedIn: true, editing: true, i18n: auth.i18n,
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
  await purgeCommentModerationCache(auth.db);
  return new Response(null, {
    status: 302,
    headers: { Location: safeAdminRedirectUrl(request.headers.get('referer'), auth.options.siteUrl || '', '/admin/manage-comments') },
  });
};
