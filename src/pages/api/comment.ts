import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook } from '@/lib/plugin';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  // Load activated plugins
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  const formData = await request.formData();
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);
  const parent = parseInt(formData.get('parent')?.toString() || '0', 10);
  const text = formData.get('text')?.toString()?.trim() || '';
  let author = formData.get('author')?.toString()?.trim() || '';
  let mail = formData.get('mail')?.toString()?.trim() || '';
  let url = formData.get('url')?.toString()?.trim() || '';

  if (!cid || !text) {
    return new Response('评论内容不能为空', { status: 400 });
  }

  // Check if content exists and allows comments
  const content = await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });

  if (!content) {
    return new Response('文章不存在', { status: 404 });
  }

  if (content.allowComment !== '1') {
    return new Response('评论已关闭', { status: 403 });
  }

  // Check if content has password protection
  if (content.password) {
    return new Response('不能对加密文章评论', { status: 403 });
  }

  // Check auth
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  let userId = 0;
  let ownerId = content.authorId || 0;

  if (token && options.secret) {
    const result = await validateAuthToken(token, options.secret, db);
    if (result) {
      userId = result.uid;
      author = result.user.screenName || result.user.name || author;
      mail = result.user.mail || mail;
      url = result.user.url || url;
    }
  }

  // Validate for anonymous users
  if (!userId) {
    if (!author) {
      return new Response('请填写称呼', { status: 400 });
    }
    if (options.commentsRequireMail && !mail) {
      return new Response('请填写邮箱', { status: 400 });
    }
    if (options.commentsRequireURL && !url) {
      return new Response('请填写网站地址', { status: 400 });
    }
  }

  // Anti-spam: check comment interval
  if (options.commentsPostIntervalEnable && !userId) {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
    const recentComment = await db
      .select({ created: schema.comments.created })
      .from(schema.comments)
      .where(eq(schema.comments.ip, ip))
      .orderBy(sql`${schema.comments.created} DESC`)
      .limit(1);

    if (recentComment[0]) {
      const elapsed = Math.floor(Date.now() / 1000) - (recentComment[0].created || 0);
      if (elapsed < (options.commentsPostInterval || 60)) {
        return new Response(`评论过于频繁，请等待 ${options.commentsPostInterval - elapsed} 秒后再试`, { status: 429 });
      }
    }
  }

  // Determine comment status
  let status = 'approved';
  if (options.commentsRequireModeration) {
    status = 'waiting';
  }
  if (options.commentsWhitelist && !userId) {
    // Check if this commenter has been approved before
    const approved = await db.query.comments.findFirst({
      where: and(
        eq(schema.comments.mail, mail),
        eq(schema.comments.status, 'approved')
      ),
    });
    if (!approved) {
      status = 'waiting';
    }
  }

  // Check parent comment exists
  if (parent > 0) {
    const parentComment = await db.query.comments.findFirst({
      where: and(
        eq(schema.comments.coid, parent),
        eq(schema.comments.cid, cid)
      ),
    });
    if (!parentComment) {
      return new Response('父评论不存在', { status: 400 });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  const agent = request.headers.get('user-agent') || '';

  // Insert comment
  let commentData: Record<string, any> = {
    cid,
    created: now,
    author,
    authorId: userId,
    ownerId,
    mail,
    url,
    ip,
    agent,
    text,
    type: 'comment',
    status,
    parent,
  };

  // Apply feedback:comment filter — plugins can modify comment data before save
  // Extra context is passed so plugins (e.g. captcha) can access form data and request
  commentData = await applyFilter('feedback:comment', commentData, {
    request, formData, db, options, isLoggedIn: !!userId,
  });

  // Check if any plugin rejected the comment (e.g. captcha verification failed)
  if (commentData._rejected) {
    const reason = commentData._rejected;
    delete commentData._rejected;
    return new Response(reason, { status: 403 });
  }

  await db.insert(schema.comments).values(commentData as any);

  // Update comment count if approved
  if (status === 'approved') {
    await db
      .update(schema.contents)
      .set({
        commentsNum: sql`${schema.contents.commentsNum} + 1`,
      })
      .where(eq(schema.contents.cid, cid));
  }

  // Trigger feedback:finishComment hook — plugins can act after comment saved
  await doHook('feedback:finishComment', commentData);

  // Redirect back to the post
  const referer = request.headers.get('referer') || `/archives/${cid}/`;
  return new Response(null, {
    status: 302,
    headers: { Location: `${referer}#comments` },
  });
};
