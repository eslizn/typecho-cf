import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import {
  applyCommentActions,
  deleteSpamCommentsForUser,
  getModeratableComments,
  normalizeCommentAction,
  purgeCommentModerationCache,
} from '@/lib/comment-moderation';
import { readAdminFormOrError } from '@/lib/input';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const GET: APIRoute = async ({ request }) =>
  textError(405, i18nMessage('core.error.methodNotAllowed', 'Method Not Allowed'), undefined, createCoreRequestI18n(request).i18n);
export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const action = url.searchParams.get('do') || '';

  // Special action: delete all spam
  if (action === 'delete-spam') {
    await deleteSpamCommentsForUser(auth.db, auth.user);
    await purgeCommentModerationCache(auth.db, auth.options);

    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-comments?status=spam',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  const normalizedAction = normalizeCommentAction(action);
  if (!normalizedAction) {
    return textError(400, i18nMessage('admin.batch.invalidAction', 'Invalid action.'), undefined, auth.i18n);
  }

  // Get selected coids from form body
  let coids: number[] = [];
  if (request.method === 'POST') {
    const formData = await readAdminFormOrError(request, undefined, auth.i18n);
    if (formData instanceof Response) return formData;
    coids = [...new Set(
      formData.getAll('coid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean),
    )];
  }

  if (coids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-comments',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  const pluginCtx = auth.pluginCtx;

  const comments = await getModeratableComments(auth.db, coids, auth.user, auth.i18n);
  if (comments instanceof Response) return comments;
  await applyCommentActions(pluginCtx, auth.db, comments, normalizedAction, auth.options);

  // Comments affect post pages and feeds
  await purgeCommentModerationCache(auth.db, auth.options);

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-comments',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
