import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import {
  applyCommentAction,
  getModeratableComment,
  normalizeCommentAction,
  purgeCommentModerationCache,
} from '@/lib/comment-moderation';
import { readAdminFormOrError } from '@/lib/input';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const GET: APIRoute = async ({ request }) =>
  textError(405, i18nMessage('core.error.methodNotAllowed', 'Method Not Allowed'), undefined, createCoreRequestI18n(request).i18n);

export const POST: APIRoute = async ({ request, locals, url }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, auth.i18n);

  const formData = await readAdminFormOrError(request, undefined, auth.i18n);
  if (formData instanceof Response) return formData;
  const action = normalizeCommentAction(
    formData.get('action')?.toString() || url.searchParams.get('action') || '',
  );
  const coid = parseInt(
    formData.get('coid')?.toString() || url.searchParams.get('coid') || '0',
    10,
  );
  if (!action || !coid) return error(400, 'core.error.badRequest', {}, 'Bad Request');

  const comment = await getModeratableComment(auth.db, coid, auth.user, auth.i18n);
  if (comment instanceof Response) return comment;

  await applyCommentAction(auth.pluginCtx, auth.db, comment, action, auth.options);
  await purgeCommentModerationCache(auth.db);

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-comments',
  );
  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
