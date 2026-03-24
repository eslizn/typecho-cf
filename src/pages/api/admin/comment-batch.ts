import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = handler;
export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'contributor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const action = url.searchParams.get('do') || '';

  // Special action: delete all spam
  if (action === 'delete-spam') {
    // Get all spam comments
    const spamComments = await db.select({ coid: schema.comments.coid, cid: schema.comments.cid, status: schema.comments.status })
      .from(schema.comments)
      .where(eq(schema.comments.status, 'spam'));

    for (const comment of spamComments) {
      await db.delete(schema.comments).where(eq(schema.comments.coid, comment.coid));
    }

    const referer = request.headers.get('referer') || '/admin/manage-comments?status=spam';
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

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
    const comment = await db.query.comments.findFirst({
      where: eq(schema.comments.coid, coid),
    });
    if (!comment) continue;

    const oldStatus = comment.status;

    if (action === 'delete') {
      await db.delete(schema.comments).where(eq(schema.comments.coid, coid));

      if (oldStatus === 'approved') {
        await db.update(schema.contents)
          .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
          .where(eq(schema.contents.cid, comment.cid || 0));
      }
    } else if (action === 'approved') {
      await db.update(schema.comments)
        .set({ status: 'approved' })
        .where(eq(schema.comments.coid, coid));

      if (oldStatus !== 'approved') {
        await db.update(schema.contents)
          .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
          .where(eq(schema.contents.cid, comment.cid || 0));
      }
    } else if (action === 'waiting') {
      await db.update(schema.comments)
        .set({ status: 'waiting' })
        .where(eq(schema.comments.coid, coid));

      if (oldStatus === 'approved') {
        await db.update(schema.contents)
          .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
          .where(eq(schema.contents.cid, comment.cid || 0));
      }
    } else if (action === 'spam') {
      await db.update(schema.comments)
        .set({ status: 'spam' })
        .where(eq(schema.comments.coid, coid));

      if (oldStatus === 'approved') {
        await db.update(schema.contents)
          .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
          .where(eq(schema.contents.cid, comment.cid || 0));
      }
    }
  }

  const referer = request.headers.get('referer') || '/admin/manage-comments';
  return new Response(null, { status: 302, headers: { Location: referer } });
}
