import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, validateCommentToken } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook } from '@/lib/plugin';
import { purgeContentCache } from '@/lib/cache';
import { getClientIp } from '@/lib/context';
import { buildPermalink } from '@/lib/content';
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

  // Limit comment text length
  if (text.length > 10000) {
    return new Response('评论内容过长', { status: 400 });
  }

  // Check if content exists and allows comments
  const content = await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });

  if (!content) {
    return new Response('文章不存在', { status: 404 });
  }

  const isPublicContent =
    (content.type === 'post' || content.type === 'page') &&
    (content.status === 'publish' || content.status === 'hidden');
  if (!isPublicContent) {
    return new Response('评论目标不可用', { status: 403 });
  }

  if (content.allowComment !== '1') {
    return new Response('评论已关闭', { status: 403 });
  }

  // Check if content has password protection
  if (content.password) {
    return new Response('不能对加密文章评论', { status: 403 });
  }

  // Check if comments are auto-closed due to age
  if (options.commentsAutoClose && options.commentsPostTimeout && content.created) {
    const ageSeconds = Math.floor(Date.now() / 1000) - content.created;
    if (ageSeconds > options.commentsPostTimeout) {
      return new Response('评论已关闭（文章发布时间过长）', { status: 403 });
    }
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
    // Basic email format validation
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return new Response('邮箱格式不正确', { status: 400 });
    }
  }

  // Check referer URL matches the content's URL (anti-spam: ensure comment came from a real page view)
  if (options.commentsCheckReferer) {
    const refererHeader = request.headers.get('referer') || '';
    const siteUrl = options.siteUrl?.replace(/\/$/, '') || '';
    if (!refererHeader || (siteUrl && !refererHeader.startsWith(siteUrl))) {
      return new Response('评论来源页 URL 不合法', { status: 403 });
    }
  }

  // Resolve client IP once — used for anti-spam rate-limit and stored with the comment
  const ip = getClientIp(request);

  // Anti-spam: check comment interval
  if (options.commentsPostIntervalEnable && !userId) {
    const recentComment = await db
      .select({ created: schema.comments.created })
      .from(schema.comments)
      .where(and(
        eq(schema.comments.cid, cid),
        eq(schema.comments.ip, ip)
      ))
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
  const agent = request.headers.get('user-agent') || '';

  // Insert comment
  let commentData: Record<string, unknown> = {
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

  // Anti-spam: CSRF token check (matches Typecho's Security::protect())
  // Token = SHA256(secret + '&' + requestUrl), embedded in comment form as <input name="_">
  if (options.commentsAntiSpam && !userId) {
    const submittedToken = formData.get('_')?.toString() || '';
    const refererUrl = (request.headers.get('referer') || '').split('#')[0];
    const valid = refererUrl
      ? await validateCommentToken(submittedToken, options.secret as string, refererUrl)
      : false;
    if (!valid) {
      return new Response('评论来源验证失败', { status: 403 });
    }
  }

  // Apply feedback:comment filter — plugins can modify/reject comment data before save
  commentData = await applyFilter('feedback:comment', commentData, {
    request, formData, db, options, isLoggedIn: !!userId,
  });

  // Check if any plugin rejected the comment (e.g. captcha verification failed)
  if (commentData._rejected) {
    const reason = String(commentData._rejected);
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

  const contentUrl = buildPermalink(
    { cid: content.cid, slug: content.slug, type: content.type, created: content.created },
    options.siteUrl || '',
    options.permalinkPattern as string | undefined,
    options.pagePattern as string | undefined,
  );
  await purgeContentCache(options.siteUrl || '', cid, { contentUrl });

  // Redirect back to the post
  // Prevent open redirect: only use referer if it's a relative path or same-origin
  let redirectUrl = `/archives/${cid}/#comments`;
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const siteHost = options.siteUrl ? new URL(options.siteUrl).host : '';
      if (refUrl.host === siteHost || refUrl.host === new URL(request.url).host) {
        redirectUrl = `${refUrl.pathname}${refUrl.search}#comments`;
      }
    } catch {
      // Invalid referer URL, use default
    }
  }
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  });
};
