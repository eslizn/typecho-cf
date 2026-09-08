import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { uploadToR2 } from '@/lib/upload';
import { deleteAttachments } from '@/lib/attachment-lifecycle';
import { applyFilter, doHook } from '@/lib/plugin';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { REQUEST_BODY_LIMITS, UPLOAD_RATE_LIMIT } from '@/lib/constants';
import { InputError, readBoundedFormData } from '@/lib/input';
import { jsonError, jsonOk } from '@/lib/http';
import { env } from 'cloudflare:workers';

/**
 * R2 attachment metadata JSON persisted in contents.text for type='attachment'.
 * Written by POST /api/admin/upload; consumed by DELETE for cleanup.
 */
/**
 * Per-user upload rate limit (G5-4). See `src/lib/constants.ts` for values.
 * Human editors won't hit this; it bounds the blast radius of a stolen admin
 * token.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImageType(mime: string): boolean {
  return mime.startsWith('image/');
}

function jsonAuthError(response: Response): Response {
  return jsonError(response.status, response.status === 401 ? 'Unauthorized' : 'Forbidden');
}

export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = await requireAdminAction(request, 'contributor', { maxBodyBytes: REQUEST_BODY_LIMITS.uploadEnvelope });
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);
  const { db, options, pluginCtx } = ctx;

  // G5-4: cap per-user upload rate. Self-signed admin tokens that get
  // exfiltrated can otherwise rapidly exhaust the R2 bucket quota.
  if (!trackSlidingWindow(`upload:${ctx.uid}`, UPLOAD_RATE_LIMIT)) {
    return jsonError(429, '上传频率过高，请稍后再试', { 'Retry-After': String(UPLOAD_RATE_LIMIT.windowSeconds) });
  }

  try {
    const formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.uploadEnvelope);
    const file = formData.get('file') as File | null;

    if (!file) {
      return jsonError(400, '没有上传文件');
    }

    // upload:before — plugins can reject the upload by
    // returning { rejected: 'reason' } in the filter result.
    const beforeResult = await applyFilter(pluginCtx, 'upload:before', { rejected: null as string | null }, {
      file, request, options, user: ctx.user,
    });
    if (beforeResult?.rejected) {
      return jsonError(403, String(beforeResult.rejected));
    }

    const bucket = env.BUCKET;
    const result = await uploadToR2(bucket, file, options.siteUrl, options.attachmentTypes);

    // Create attachment content record
    const now = Math.floor(Date.now() / 1000);
    const inserted = await db.insert(schema.contents).values({
      title: file.name,
      slug: `attachment-${Date.now().toString(36)}`,
      created: now,
      modified: now,
      text: JSON.stringify({
        name: result.name,
        path: result.path,
        size: result.size,
        type: result.type,
        url: result.url,
      }),
      authorId: ctx.uid,
      type: 'attachment',
      status: 'publish',
      parent: parseInt(formData.get('cid')?.toString() || '0', 10),
    }).returning({ cid: schema.contents.cid });

    // Return format compatible with Typecho's file-upload-js.php
    // [url, {cid, title, url, bytes, isImage}]
    // G5-3: trust the server-derived result.type, not the spoofable
    // file.type from the multipart upload.
    const cid = inserted[0]?.cid;

    // upload:after — post-upload notification.
    await doHook(pluginCtx, 'upload:after', { ...result, cid }, { request, options, user: ctx.user });

    return jsonOk([
      result.url,
      {
        cid,
        title: file.name,
        url: result.url,
        bytes: formatBytes(result.size),
        isImage: isImageType(result.type),
      },
    ]);
  } catch (error) {
    if (error instanceof InputError) return jsonError(error.status, error.message);
    return jsonError(500, error instanceof Error ? error.message : '上传失败');
  }
};

/**
 * DELETE /api/admin/upload?cid=xxx - Delete an attachment
 */
export const DELETE: APIRoute = async ({ request, locals, url }) => {
  const ctx = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);
  const cid = parseInt(url.searchParams.get('cid') || '0', 10);
  if (!cid) {
    return jsonError(400, '缺少 cid 参数');
  }

  try {
    const result = await deleteAttachments({
      db: ctx.db,
      bucket: env.BUCKET,
      pluginCtx: ctx.pluginCtx,
      actor: { uid: ctx.uid, group: ctx.user.group, user: ctx.user },
      request,
      options: ctx.options,
    }, [cid]);
    if (result.missing.includes(cid)) return jsonError(404, '附件不存在');
    if (result.forbidden.includes(cid)) return jsonError(403, '无权删除此附件');
    return jsonOk({ success: true, orphanRisk: result.orphanRisk });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : '删除失败');
  }
};
