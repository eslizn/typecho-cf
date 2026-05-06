import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { uploadToR2, deleteFromR2 } from '@/lib/upload';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImageType(mime: string): boolean {
  return mime.startsWith('image/');
}

const jsonHeaders = { 'Content-Type': 'application/json' };

function jsonAuthError(response: Response): Response {
  return new Response(JSON.stringify({ error: response.status === 401 ? 'Unauthorized' : 'Forbidden' }), {
    status: response.status,
    headers: jsonHeaders,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);
  const { db, options } = ctx;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: '没有上传文件' }), { status: 400, headers: jsonHeaders });
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
    const cid = inserted[0]?.cid;
    return new Response(JSON.stringify([
      result.url,
      {
        cid,
        title: file.name,
        url: result.url,
        bytes: formatBytes(result.size),
        isImage: isImageType(file.type),
      },
    ]), { status: 200, headers: jsonHeaders });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : '上传失败',
    }), { status: 500, headers: jsonHeaders });
  }
};

/**
 * DELETE /api/admin/upload?cid=xxx - Delete an attachment
 */
export const DELETE: APIRoute = async ({ request, locals, url }) => {
  const ctx = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(ctx)) return jsonAuthError(ctx);
  const { db } = ctx;

  const cid = parseInt(url.searchParams.get('cid') || '0', 10);
  if (!cid) {
    return new Response(JSON.stringify({ error: '缺少 cid 参数' }), { status: 400, headers: jsonHeaders });
  }

  try {
    const attachment = await db.query.contents.findFirst({
      where: eq(schema.contents.cid, cid),
    });

    if (!attachment || attachment.type !== 'attachment') {
      return new Response(JSON.stringify({ error: '附件不存在' }), { status: 404, headers: jsonHeaders });
    }

    // Check ownership: non-admins can only delete their own attachments
    const isAdmin = hasPermission(ctx.user.group || 'visitor', 'administrator');
    if (!isAdmin && attachment.authorId !== ctx.uid) {
      return new Response(JSON.stringify({ error: '无权删除此附件' }), { status: 403, headers: jsonHeaders });
    }

    // Delete file from R2
    try {
      const meta = JSON.parse(attachment.text || '{}');
      if (meta.path) {
        const bucket = env.BUCKET;
        await deleteFromR2(bucket, meta.path);
      }
    } catch {
      // Ignore R2 deletion errors, still remove DB record
    }

    // Delete DB record
    await db.delete(schema.contents).where(eq(schema.contents.cid, cid));

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: jsonHeaders });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : '删除失败',
    }), { status: 500, headers: jsonHeaders });
  }
};
