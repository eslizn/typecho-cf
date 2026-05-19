import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
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

  const action = url.searchParams.get('do') || '';
  const markStatusInput = url.searchParams.get('status') || '';
  const VALID_STATUSES = ['publish', 'draft', 'hidden', 'private', 'waiting'];
  const markStatus = VALID_STATUSES.includes(markStatusInput) ? markStatusInput : '';
  const type = url.searchParams.get('type') || 'post';
  if (action !== 'delete' && !(action === 'mark' && markStatus)) {
    return new Response('Invalid action', { status: 400 });
  }

  let cids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    cids = formData.getAll('cid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  // Typecho uses JS to collect checkboxes and submit — redirect back if no cids
  if (cids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    // G4-2: fetch all targeted contents in one query rather than per-cid
    // findFirst, then trigger plugin hooks and emit one big delete batch.
    const contents = await auth.db.select().from(schema.contents)
      .where(sql`${schema.contents.cid} IN (${sql.join(cids.map(id => sql`${id}`), sql`, `)})`);

    const allowedContents = contents.filter(c => isAdmin || c.authorId === auth.uid);
    if (allowedContents.length === 0) {
      return new Response(null, { status: 302, headers: {
        Location: type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
      } });
    }

    const allowedCids = allowedContents.map(c => c.cid);

    // Pre-delete hooks (must run sequentially: plugins may rely on
    // ordering and on the row still being present).
    for (const content of allowedContents) {
      const isPage = content.type?.startsWith('page');
      await doHook(isPage ? 'page:delete' : 'post:delete', content);
    }

    // Decrement meta counts in one pass: collect all (cid -> [mid]) and
    // run a single relationship lookup, then update each meta once with
    // the actual decrement count.
    const rels = await auth.db.select({ cid: schema.relationships.cid, mid: schema.relationships.mid })
      .from(schema.relationships)
      .where(sql`${schema.relationships.cid} IN (${sql.join(allowedCids.map(id => sql`${id}`), sql`, `)})`);
    const decrementByMid = new Map<number, number>();
    for (const rel of rels) {
      decrementByMid.set(rel.mid, (decrementByMid.get(rel.mid) || 0) + 1);
    }

    // Now stream the writes through D1 batch — atomic and single-round-trip.
    const decrementStmts = Array.from(decrementByMid.entries()).map(([mid, n]) =>
      auth.db.update(schema.metas)
        .set({ count: sql`MAX(0, ${schema.metas.count} - ${n})` })
        .where(eq(schema.metas.mid, mid))
    );
    const cidList = sql.join(allowedCids.map(id => sql`${id}`), sql`, `);
    const deleteStmts = [
      auth.db.delete(schema.relationships).where(sql`${schema.relationships.cid} IN (${cidList})`),
      auth.db.delete(schema.comments).where(sql`${schema.comments.cid} IN (${cidList})`),
      auth.db.delete(schema.fields).where(sql`${schema.fields.cid} IN (${cidList})`),
      auth.db.delete(schema.contents).where(sql`${schema.contents.cid} IN (${cidList})`),
    ];
    const all = [...decrementStmts, ...deleteStmts];
    if (all.length > 0) {
      // drizzle-orm/d1 exposes `batch()` — fall back to sequential
      // execution for environments (libsql tests) that don't.
      const batchFn = (auth.db as any).batch;
      if (typeof batchFn === 'function') {
        await batchFn.call(auth.db, all as any);
      } else {
        for (const stmt of all) await stmt;
      }
    }

    // Post-delete hooks
    for (const content of allowedContents) {
      const isPage = content.type?.startsWith('page');
      await doHook(isPage ? 'page:finishDelete' : 'post:finishDelete', content);
    }
  } else if (action === 'mark' && markStatus) {
    if (!isEditor) {
      return new Response('Forbidden', { status: 403 });
    }

    const contents = await auth.db.select().from(schema.contents)
      .where(sql`${schema.contents.cid} IN (${sql.join(cids.map(id => sql`${id}`), sql`, `)})`);
    const allowedCids = contents
      .filter(c => isAdmin || c.authorId === auth.uid)
      .map(c => c.cid);
    if (allowedCids.length > 0) {
      await auth.db.update(schema.contents)
        .set({ status: markStatus })
        .where(sql`${schema.contents.cid} IN (${sql.join(allowedCids.map(id => sql`${id}`), sql`, `)})`);
    }
  }

  await bumpCacheVersion(auth.db);
  await purgeContentCache(auth.options.siteUrl || '');

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
