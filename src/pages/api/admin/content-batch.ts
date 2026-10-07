import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { canManageResource, hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { doHook } from '@/lib/plugin';
import { invalidateSiteCache } from '@/lib/cache';
import { readAdminFormOrError } from '@/lib/input';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const pluginCtx = auth.pluginCtx;

  const isEditor = hasPermission(auth.user.group || 'visitor', 'editor');

  const action = url.searchParams.get('do') || '';
  const markStatusInput = url.searchParams.get('status') || '';
  const VALID_STATUSES = ['publish', 'draft', 'hidden', 'private', 'waiting'];
  const markStatus = VALID_STATUSES.includes(markStatusInput) ? markStatusInput : '';
  const type = url.searchParams.get('type') || 'post';
  if (action !== 'delete' && !(action === 'mark' && markStatus)) {
    return textError(400, i18nMessage('admin.batch.invalidAction', 'Invalid action.'), undefined, auth.i18n);
  }

  let cids: number[] = [];
  if (request.method === 'POST') {
    const formData = await readAdminFormOrError(request, undefined, auth.i18n);
    if (formData instanceof Response) return formData;
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

    const allowedContents = contents.filter(c => canManageResource(auth.user, c));
    if (allowedContents.length === 0) {
      return new Response(null, { status: 302, headers: {
        Location: type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
      } });
    }

    const allowedCids = allowedContents.map(c => c.cid);
    const revisions = await auth.db.select({ cid: schema.contents.cid }).from(schema.contents)
      .where(and(eq(schema.contents.type, 'revision'), inArray(schema.contents.parent, allowedCids)));
    const deleteCids = [...new Set([...allowedCids, ...revisions.map(revision => revision.cid)])];
    const countedCids = allowedContents.filter(content => content.type !== 'revision').map(content => content.cid);

    // Pre-delete hooks (must run sequentially: plugins may rely on
    // ordering and on the row still being present).
    for (const content of allowedContents) {
      const isPage = content.type?.startsWith('page');
      await doHook(pluginCtx, isPage ? 'page:beforeDelete' : 'post:beforeDelete', content, {
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
    }

    const cidList = sql.join(deleteCids.map(id => sql`${id}`), sql`, `);
    // Derive each counter delta from relationships still present when this
    // batch executes. A preflight read could become stale before the batch
    // and leave metadata counts inconsistent with the rows being deleted.
    const decrementStmts = countedCids.length > 0
      ? [auth.db.update(schema.metas)
        .set({
          count: sql`MAX(0, ${schema.metas.count} - (
            SELECT COUNT(*) FROM ${schema.relationships}
            WHERE ${schema.relationships.mid} = ${schema.metas.mid}
              AND ${schema.relationships.cid} IN (${sql.join(countedCids.map(id => sql`${id}`), sql`, `)})
          ))`,
        })
        .where(inArray(schema.metas.mid, auth.db.select({ mid: schema.relationships.mid })
          .from(schema.relationships)
          .where(inArray(schema.relationships.cid, countedCids))))]
      : [];

    // Counter updates and relationship/content deletion share one D1 batch.
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
      await doHook(pluginCtx, isPage ? 'page:afterDelete' : 'post:afterDelete', content, {
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
    }
  } else if (action === 'mark' && markStatus) {
    if (!isEditor) {
      return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, auth.i18n);
    }

    const contents = await auth.db.select().from(schema.contents)
      .where(sql`${schema.contents.cid} IN (${sql.join(cids.map(id => sql`${id}`), sql`, `)})`);
    const allowedContents = contents.filter(content =>
      ['post', 'post_draft', 'page', 'page_draft'].includes(content.type || '')
      && canManageResource(auth.user, content));
    const allowedCids = allowedContents.map(content => content.cid);
    if (allowedCids.length > 0) {
      await auth.db.update(schema.contents)
        .set({
          status: markStatus,
          type: markStatus === 'draft' ? sql`${schema.contents.type}` : sql`CASE ${schema.contents.type}
            WHEN 'post_draft' THEN 'post'
            WHEN 'page_draft' THEN 'page'
            ELSE ${schema.contents.type} END`,
        })
        .where(sql`${schema.contents.cid} IN (${sql.join(allowedCids.map(id => sql`${id}`), sql`, `)})`);
      for (const content of allowedContents) {
        const baseType = content.type!.startsWith('page') ? 'page' : 'post';
        const finishData = {
          ...content,
          status: markStatus,
          type: markStatus === 'draft' ? content.type : baseType,
        };
        if (markStatus === 'publish') {
          await doHook(pluginCtx, baseType === 'page' ? 'page:afterPublish' : 'post:afterPublish', finishData, {
            capabilityRuntime: pluginCtx.capabilityRuntime,
          });
        }
        await doHook(pluginCtx, baseType === 'page' ? 'page:afterSave' : 'post:afterSave', finishData, {
          capabilityRuntime: pluginCtx.capabilityRuntime,
        });
      }
    }
  }

  await invalidateSiteCache(auth.db);

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
