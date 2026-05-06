import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import {
  applyCommentAction,
  deleteSpamCommentsForUser,
  getModeratableComment,
  normalizeCommentAction,
  purgeCommentModerationCache,
} from '@/lib/comment-moderation';

export const GET: APIRoute = async () =>
  new Response('Method Not Allowed', { status: 405 });
export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const action = url.searchParams.get('do') || '';

  // Special action: delete all spam
  if (action === 'delete-spam') {
    await deleteSpamCommentsForUser(auth.db, auth.user);
    await purgeCommentModerationCache(auth.db, auth.options);

    const referer = request.headers.get('referer') || '/admin/manage-comments?status=spam';
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  const normalizedAction = normalizeCommentAction(action);
  if (!normalizedAction) return new Response('Invalid action', { status: 400 });

  // Get selected coids from form body
  let coids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    coids = formData.getAll('coid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  if (coids.length === 0) {
    const referer = request.headers.get('referer') || '/admin/manage-comments';
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  for (const coid of coids) {
    const comment = await getModeratableComment(auth.db, coid, auth.user);
    if (comment instanceof Response) {
      if (comment.status === 404) continue;
      return comment;
    }
    await applyCommentAction(auth.db, comment, normalizedAction);
  }

  // Comments affect post pages and feeds
  await purgeCommentModerationCache(auth.db, auth.options);

  const referer = request.headers.get('referer') || '/admin/manage-comments';
  return new Response(null, { status: 302, headers: { Location: referer } });
}
