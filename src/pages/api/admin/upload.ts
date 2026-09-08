import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, jsonAdminActionError, requireAdminAction } from '@/lib/admin-auth';
import { uploadToR2, UploadError } from '@/lib/upload';
import { deleteAttachments } from '@/lib/attachment-lifecycle';
import { applyFilter, doHook } from '@/lib/plugin';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { REQUEST_BODY_LIMITS, UPLOAD_RATE_LIMIT } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { jsonError, jsonOk } from '@/lib/http';
import { i18nMessage } from '@/lib/i18n';
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

export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = await requireAdminAction(request, 'contributor', { maxBodyBytes: REQUEST_BODY_LIMITS.uploadEnvelope });
  if (isAdminActionResponse(ctx)) return jsonAdminActionError(request, ctx);
  const { db, options, pluginCtx } = ctx;

  // G5-4: cap per-user upload rate. Self-signed admin tokens that get
  // exfiltrated can otherwise rapidly exhaust the R2 bucket quota.
  if (!trackSlidingWindow(`upload:${ctx.uid}`, UPLOAD_RATE_LIMIT)) {
    return jsonError(429, i18nMessage('admin.upload.rateLimited', 'Uploads are temporarily rate limited. Try again later.'), {
      'Retry-After': String(UPLOAD_RATE_LIMIT.windowSeconds),
    }, ctx.i18n);
  }

  try {
    const formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.uploadEnvelope);
    const file = formData.get('file') as File | null;

    if (!file) {
      return jsonError(400, i18nMessage('admin.upload.fileRequired', 'No file was uploaded.'), undefined, ctx.i18n);
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
    await doHook(pluginCtx, 'upload:after', { ...result, cid }, { request, options, user: ctx.user, i18n: ctx.i18n });

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
    if (error instanceof UploadError) {
      const message = error.code === 'extension_unknown'
        ? i18nMessage('admin.upload.extensionUnknown', 'The file extension could not be recognized: {name}', error.variables)
        : error.code === 'type_not_allowed'
          ? i18nMessage('admin.upload.typeNotAllowed', 'This file type is not allowed: {type}', error.variables)
          : error.code === 'file_too_large'
            ? i18nMessage('admin.upload.fileTooLarge', 'The file is larger than the 10 MB limit.')
            : error.code === 'filename_required'
              ? i18nMessage('admin.upload.filenameRequired', 'A filename is required.')
              : error.code === 'filename_invalid'
                ? i18nMessage('admin.upload.filenameInvalid', 'The filename is invalid.')
                : i18nMessage('admin.upload.extensionNotAllowed', 'This file extension is not allowed: {extension}', error.variables);
      return jsonError(400, message, undefined, ctx.i18n);
    }
    if (error instanceof InputError) return jsonError(error.status, inputErrorMessage(error), undefined, ctx.i18n);
    return jsonError(500, i18nMessage('admin.upload.failed', 'Upload failed.'), undefined, ctx.i18n);
  }
};

/**
 * DELETE /api/admin/upload?cid=xxx - Delete an attachment
 */
export const DELETE: APIRoute = async ({ request, locals, url }) => {
  const ctx = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(ctx)) return jsonAdminActionError(request, ctx);
  const cid = parseInt(url.searchParams.get('cid') || '0', 10);
  if (!cid) {
    return jsonError(400, i18nMessage('admin.upload.cidRequired', 'The cid parameter is required.'), undefined, ctx.i18n);
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
    if (result.missing.includes(cid)) return jsonError(404, i18nMessage('admin.upload.attachmentNotFound', 'The attachment does not exist.'), undefined, ctx.i18n);
    if (result.forbidden.includes(cid)) return jsonError(403, i18nMessage('admin.upload.attachmentForbidden', 'You do not have permission to delete this attachment.'), undefined, ctx.i18n);
    return jsonOk({ success: true, orphanRisk: result.orphanRisk });
  } catch (error) {
    return jsonError(500, i18nMessage('admin.upload.deleteFailed', 'The attachment could not be deleted.'), undefined, ctx.i18n);
  }
};
