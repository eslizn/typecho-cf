import { sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { hasPermission } from '@/lib/auth';
import { parseAttachmentMeta, type AttachmentMeta } from '@/lib/attachment';
import { doHook, type HookContext } from '@/lib/plugin';
import type { SiteOptions } from '@/lib/options';

export interface AttachmentLifecycleContext {
  db: Database;
  bucket: Pick<R2Bucket, 'delete'> | null | undefined;
  pluginCtx: HookContext;
  actor: {
    uid: number;
    group: string | null;
    user: typeof schema.users.$inferSelect;
  };
  request: Request;
  options: SiteOptions;
}

export interface AttachmentDeletionResult {
  deleted: number[];
  forbidden: number[];
  missing: number[];
  orphanRisk: number[];
}

interface ParsedTarget {
  cid: number;
  meta: AttachmentMeta;
  path: string | null;
}

export async function deleteAttachments(
  context: AttachmentLifecycleContext,
  cids: readonly number[],
): Promise<AttachmentDeletionResult> {
  const requested = [...new Set(cids.filter(id => Number.isSafeInteger(id) && id > 0))];
  const result: AttachmentDeletionResult = { deleted: [], forbidden: [], missing: [], orphanRisk: [] };
  if (requested.length === 0) return result;

  const idList = sql.join(requested.map(id => sql`${id}`), sql`, `);
  const rows = await context.db.select().from(schema.contents)
    .where(sql`${schema.contents.cid} IN (${idList})`);
  const byId = new Map(rows.map(row => [row.cid, row]));
  const isAdmin = hasPermission(context.actor.group || 'visitor', 'administrator');
  const targets: ParsedTarget[] = [];

  for (const cid of requested) {
    const row = byId.get(cid);
    if (!row || row.type !== 'attachment') {
      result.missing.push(cid);
      continue;
    }
    if (!isAdmin && row.authorId !== context.actor.uid) {
      result.forbidden.push(cid);
      continue;
    }
    const meta = parseAttachmentMeta(row.text);
    const path = typeof meta.path === 'string' && meta.path.trim() ? meta.path : null;
    if (!path) recordOrphanRisk(result, cid, 'metadata_path_missing');
    targets.push({ cid, meta, path });
  }

  const storageResults = await Promise.allSettled(targets.map(async target => {
    if (!target.path) return;
    if (!context.bucket) throw new Error('R2 binding unavailable');
    await context.bucket.delete(target.path);
  }));
  storageResults.forEach((storageResult, index) => {
    if (storageResult.status === 'rejected') {
      recordOrphanRisk(result, targets[index].cid, 'r2_delete_failed', storageResult.reason);
    }
  });

  for (const target of targets) {
    await doHook(context.pluginCtx, 'upload:delete', {
      cid: target.cid,
      ...target.meta,
    }, {
      request: context.request,
      options: context.options,
      user: context.actor.user,
      capabilityRuntime: context.pluginCtx.capabilityRuntime,
    });
  }

  if (targets.length > 0) {
    const targetIds = targets.map(target => target.cid);
    const deleteList = sql.join(targetIds.map(id => sql`${id}`), sql`, `);
    await context.db.delete(schema.contents)
      .where(sql`${schema.contents.cid} IN (${deleteList})`);
    result.deleted.push(...targetIds);
  }
  return result;
}

function recordOrphanRisk(
  result: AttachmentDeletionResult,
  cid: number,
  reason: 'metadata_path_missing' | 'r2_delete_failed',
  error?: unknown,
): void {
  if (!result.orphanRisk.includes(cid)) result.orphanRisk.push(cid);
  console.warn({
    event: 'attachment_orphan_risk',
    cid,
    reason,
    error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
  });
}
