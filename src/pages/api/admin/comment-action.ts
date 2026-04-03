import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { purgeContentCache } from '@/lib/cache';
import { eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ request, locals, url }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'contributor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const action = url.searchParams.get('action');
  const coid = parseInt(url.searchParams.get('coid') || '0', 10);
  if (!action || !coid) return new Response('Bad Request', { status: 400 });

  const comment = await db.query.comments.findFirst({
    where: eq(schema.comments.coid, coid),
  });
  if (!comment) return new Response('Not Found', { status: 404 });

  const oldStatus = comment.status;

  if (action === 'approve') {
    await db.update(schema.comments)
      .set({ status: 'approved' })
      .where(eq(schema.comments.coid, coid));

    if (oldStatus !== 'approved') {
      await db.update(schema.contents)
        .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
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
  } else if (action === 'waiting') {
    await db.update(schema.comments)
      .set({ status: 'waiting' })
      .where(eq(schema.comments.coid, coid));

    if (oldStatus === 'approved') {
      await db.update(schema.contents)
        .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
        .where(eq(schema.contents.cid, comment.cid || 0));
    }
  } else if (action === 'delete') {
    await db.delete(schema.comments).where(eq(schema.comments.coid, coid));

    if (oldStatus === 'approved') {
      await db.update(schema.contents)
        .set({ commentsNum: sql`MAX(0, ${schema.contents.commentsNum} - 1)` })
        .where(eq(schema.contents.cid, comment.cid || 0));
    }
  }

  await purgeContentCache(options.siteUrl || '', comment.cid || 0);

  const referer = request.headers.get('referer') || '/admin/manage-comments';
  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
