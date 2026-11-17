import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { canManageResource, hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { doHook } from '@/lib/plugin';
import { invalidateSiteCache } from '@/lib/cache';
import { readAdminFormOrError } from '@/lib/input';
import { chunkArray, D1_SAFE_IN_LIST_SIZE } from '@/lib/d1-limits';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = handler;

type BatchContentType = 'post' | 'page';
type ContentRow = typeof schema.contents.$inferSelect;

function matchesBatchType(type: string | null | undefined, batchType: BatchContentType): boolean {
  return batchType === 'page'
    ? type === 'page' || type === 'page_draft'
    : type === 'post' || type === 'post_draft';
}

function isPageContentType(type: string | null | undefined): boolean {
  return type === 'page' || type === 'page_draft';
}

async function loadContentsChunked(db: any, cids: number[]): Promise<ContentRow[]> {
  const rows: ContentRow[] = [];
  for (const chunk of chunkArray([...new Set(cids)], D1_SAFE_IN_LIST_SIZE)) {
    rows.push(...await db.select().from(schema.contents).where(inArray(schema.contents.cid, chunk)));
  }
  return rows;
}

async function handler({ request, url }: { request: Request; url: URL }) {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const pluginCtx = auth.pluginCtx;

  const isEditor = hasPermission(auth.user.group || 'visitor', 'editor');

  const action = url.searchParams.get('do') || '';
  const markStatusInput = url.searchParams.get('status') || '';
  const VALID_STATUSES = ['publish', 'draft', 'hidden', 'private', 'waiting'];
  const markStatus = VALID_STATUSES.includes(markStatusInput) ? markStatusInput : '';
  const type: BatchContentType = url.searchParams.get('type') === 'page' ? 'page' : 'post';
  if (action !== 'delete' && !(action === 'mark' && markStatus)) {
    return textError(400, i18nMessage('admin.batch.invalidAction', 'Invalid action.'), undefined, auth.i18n);
  }

  // Typecho exposes page management to editors only.
  if (type === 'page' && !isEditor) {
    return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, auth.i18n);
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
    const contents = await loadContentsChunked(auth.db, cids);
    const allowedContents = contents.filter(content =>
      matchesBatchType(content.type, type)
      && canManageResource(auth.user, content));
    if (allowedContents.length === 0) {
      return new Response(null, { status: 302, headers: {
        Location: type === 'page' ? '/admin/manage-pages' : '/admin/manage-posts',
      } });
    }

    const allowedCids = allowedContents.map(c => c.cid);
    const revisions: Array<{ cid: number }> = [];
    for (const chunk of chunkArray(allowedCids, D1_SAFE_IN_LIST_SIZE)) {
      revisions.push(...await auth.db.select({ cid: schema.contents.cid }).from(schema.contents)
        .where(and(eq(schema.contents.type, 'revision'), inArray(schema.contents.parent, chunk))));
    }
    const deleteCids = [...new Set([...allowedCids, ...revisions.map(revision => revision.cid)])];
    const countedCids = allowedContents.map(content => content.cid);

    // Pre-delete hooks (must run sequentially: plugins may rely on
    // ordering and on the row still being present).
    for (const content of allowedContents) {
      const isPage = isPageContentType(content.type);
      await doHook(pluginCtx, isPage ? 'page:beforeDelete' : 'post:beforeDelete', content, {
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
    }

    // Derive each counter delta from relationships still present when this
    // batch executes. A preflight read could become stale before the batch
    // and leave metadata counts inconsistent with the rows being deleted.
    // Chunk the selected cids (each statement binds the list twice) so D1's
    // 100-bound-parameter cap is respected.
    const decrementStmts: any[] = [];
    for (const chunk of chunkArray(countedCids, 45)) {
      decrementStmts.push(
        auth.db.update(schema.metas)
          .set({
            count: sql`MAX(0, ${schema.metas.count} - (
              SELECT COUNT(*) FROM ${schema.relationships}
              WHERE ${schema.relationships.mid} = ${schema.metas.mid}
                AND ${schema.relationships.cid} IN (${sql.join(chunk.map(id => sql`${id}`), sql`, `)})
            ))`,
          })
          .where(inArray(schema.metas.mid, auth.db.select({ mid: schema.relationships.mid })
            .from(schema.relationships)
            .where(inArray(schema.relationships.cid, chunk)))),
      );
    }

    // Deletion statements are chunked to stay under D1's parameter cap.
    const deleteStmts: any[] = [];
    for (const chunk of chunkArray(deleteCids, D1_SAFE_IN_LIST_SIZE)) {
      deleteStmts.push(
        auth.db.delete(schema.relationships).where(inArray(schema.relationships.cid, chunk)),
        auth.db.delete(schema.comments).where(inArray(schema.comments.cid, chunk)),
        auth.db.delete(schema.fields).where(inArray(schema.fields.cid, chunk)),
        auth.db.delete(schema.contents).where(inArray(schema.contents.cid, chunk)),
      );
    }

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
      const isPage = isPageContentType(content.type);
      await doHook(pluginCtx, isPage ? 'page:afterDelete' : 'post:afterDelete', content, {
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
    }
  } else if (action === 'mark' && markStatus) {
    if (!isEditor) {
      return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, auth.i18n);
    }

    const contents = await loadContentsChunked(auth.db, cids);
    const allowedContents = contents.filter(content =>
      matchesBatchType(content.type, type)
      && canManageResource(auth.user, content));
    const allowedCids = allowedContents.map(content => content.cid);
    if (allowedCids.length > 0) {
      // Chunked for D1's parameter cap, but committed as one atomic batch so
      // a large selection cannot be partially marked when a later chunk fails.
      const markStatements = chunkArray(allowedCids, D1_SAFE_IN_LIST_SIZE).map(chunk =>
        auth.db.update(schema.contents)
          .set({
            status: markStatus,
            type: markStatus === 'draft' ? sql`${schema.contents.type}` : sql`CASE ${schema.contents.type}
              WHEN 'post_draft' THEN 'post'
              WHEN 'page_draft' THEN 'page'
              ELSE ${schema.contents.type} END`,
          })
          .where(inArray(schema.contents.cid, chunk)));
      const batchFn = (auth.db as any).batch;
      if (typeof batchFn === 'function') {
        await batchFn.call(auth.db, markStatements as any);
      } else {
        for (const statement of markStatements) await statement;
      }
      for (const content of allowedContents) {
        const baseType = isPageContentType(content.type) ? 'page' : 'post';
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
