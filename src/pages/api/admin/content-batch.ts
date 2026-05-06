import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { setActivatedPlugins, parseActivatedPlugins, doHook } from '@/lib/plugin';
import { bumpCacheVersion, purgeContentCache } from '@/lib/cache';
import { eq, sql } from 'drizzle-orm';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const activatedIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  const isEditor = hasPermission(auth.user.group || 'visitor', 'editor');

  // Get action from query params
  const action = url.searchParams.get('do') || '';
  const markStatusInput = url.searchParams.get('status') || '';
  const VALID_STATUSES = ['publish', 'draft', 'hidden', 'private', 'waiting'];
  const markStatus = VALID_STATUSES.includes(markStatusInput) ? markStatusInput : '';
  const type = url.searchParams.get('type') || 'post';
  if (action !== 'delete' && !(action === 'mark' && markStatus)) {
    return new Response('Invalid action', { status: 400 });
  }

  // Get selected cids from form body or referer page's form
  let cids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    cids = formData.getAll('cid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  // For GET requests with batch actions, we need the cids from the referring form
  // Typecho uses JS to collect checkboxes and submit - redirect back if no cids
  if (cids.length === 0) {
    const referer = request.headers.get('referer') || (type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts');
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    for (const cid of cids) {
      const content = await auth.db.query.contents.findFirst({
        where: eq(schema.contents.cid, cid),
      });
      if (!content) continue;

      // Check permission
      if (!isAdmin && content.authorId !== auth.uid) continue;

      const isPage = content.type?.startsWith('page');
      await doHook(isPage ? 'page:delete' : 'post:delete', content);

      // Decrement meta counts
      const rels = await auth.db.select({ mid: schema.relationships.mid })
        .from(schema.relationships)
        .where(eq(schema.relationships.cid, cid));
      for (const rel of rels) {
        await auth.db.update(schema.metas)
          .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
          .where(eq(schema.metas.mid, rel.mid));
      }
      // Delete relationships, comments, fields, content
      await auth.db.delete(schema.relationships).where(eq(schema.relationships.cid, cid));
      await auth.db.delete(schema.comments).where(eq(schema.comments.cid, cid));
      await auth.db.delete(schema.fields).where(eq(schema.fields.cid, cid));
      await auth.db.delete(schema.contents).where(eq(schema.contents.cid, cid));

      await doHook(isPage ? 'page:finishDelete' : 'post:finishDelete', content);
    }
  } else if (action === 'mark' && markStatus) {
    if (!isEditor) {
      return new Response('Forbidden', { status: 403 });
    }

    for (const cid of cids) {
      const content = await auth.db.query.contents.findFirst({
        where: eq(schema.contents.cid, cid),
      });
      if (!content) continue;
      if (!isAdmin && content.authorId !== auth.uid) continue;

      await auth.db.update(schema.contents).set({
        status: markStatus,
      }).where(eq(schema.contents.cid, cid));
    }
  }

  await bumpCacheVersion(auth.db);
  await purgeContentCache(auth.options.siteUrl || '');

  const referer = request.headers.get('referer') || (type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts');
  return new Response(null, { status: 302, headers: { Location: referer } });
}
