import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission, requireAdminCSRF } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, doHook } from '@/lib/plugin';
import { purgeContentCache } from '@/lib/cache';
import { eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'contributor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid);
  if (csrfError) return csrfError;

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  const isEditor = hasPermission(auth.user.group || 'visitor', 'editor');

  // Get action from query params
  const action = url.searchParams.get('do') || '';
  const markStatusInput = url.searchParams.get('status') || '';
  const VALID_STATUSES = ['publish', 'draft', 'hidden', 'private', 'waiting'];
  const markStatus = VALID_STATUSES.includes(markStatusInput) ? markStatusInput : '';
  const type = url.searchParams.get('type') || 'post';

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
      const content = await db.query.contents.findFirst({
        where: eq(schema.contents.cid, cid),
      });
      if (!content) continue;

      // Check permission
      if (!isAdmin && content.authorId !== auth.uid) continue;

      const isPage = content.type?.startsWith('page');
      await doHook(isPage ? 'page:delete' : 'post:delete', content);

      // Decrement meta counts
      const rels = await db.select({ mid: schema.relationships.mid })
        .from(schema.relationships)
        .where(eq(schema.relationships.cid, cid));
      for (const rel of rels) {
        await db.update(schema.metas)
          .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
          .where(eq(schema.metas.mid, rel.mid));
      }
      // Delete relationships, comments, fields, content
      await db.delete(schema.relationships).where(eq(schema.relationships.cid, cid));
      await db.delete(schema.comments).where(eq(schema.comments.cid, cid));
      await db.delete(schema.fields).where(eq(schema.fields.cid, cid));
      await db.delete(schema.contents).where(eq(schema.contents.cid, cid));

      await doHook(isPage ? 'page:finishDelete' : 'post:finishDelete', content);
    }
  } else if (action === 'mark' && markStatus) {
    if (!isEditor) {
      return new Response('Forbidden', { status: 403 });
    }

    for (const cid of cids) {
      const content = await db.query.contents.findFirst({
        where: eq(schema.contents.cid, cid),
      });
      if (!content) continue;
      if (!isAdmin && content.authorId !== auth.uid) continue;

      await db.update(schema.contents).set({
        status: markStatus,
      }).where(eq(schema.contents.cid, cid));
    }
  }

  await purgeContentCache(options.siteUrl || '');

  const referer = request.headers.get('referer') || (type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts');
  return new Response(null, { status: 302, headers: { Location: referer } });
}
