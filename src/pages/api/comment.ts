import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, validateCommentToken, timeSafeEqual } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook, type HookContext } from '@/lib/plugin';
import { bumpCacheVersion, purgeContentCache } from '@/lib/cache';
import { getClientIp, getRequestCoreContextFromLocals } from '@/lib/context';
import { notifyOnComment } from '@/lib/comment-email';
import { buildPermalink } from '@/lib/content';
import { normalizeHttpUrl } from '@/lib/url';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, readBoundedFormData } from '@/lib/input';
import { validateFilteredComment, WriteFilterError } from '@/lib/write-filter';

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);

  if (!isSameOriginRequest(request, options.siteUrl || '')) {
    return new Response('Forbidden', { status: 403 });
  }
  const requestReferer = request.headers.get('referer');
  if (requestReferer && !isTrustedCommentReferer(requestReferer, options.siteUrl || '')) {
    return new Response('评论来源页 URL 不合法', { status: 403 });
  }

  // Load activated plugins
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
    await setActivatedPlugins(pluginCtx, activatedIds);
  }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm);
  } catch (error) {
    if (error instanceof InputError) return new Response(error.message, { status: error.status });
    throw error;
  }
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

  // Content lookup and optional session validation are independent.
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  const [content, authResult] = await Promise.all([
    db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) }),
    token && options.secret
      ? validateAuthToken(token, options.secret, db)
      : Promise.resolve(null),
  ]);

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

  // Encrypted-post gate: allow commenting only when the submitter has
  // presented the correct password. The frontend post/page form injects
  // a hidden `password` field on the comment form so the same value that
  // decrypted the post authenticates the comment. Use a constant-time
  // comparator so response latency doesn't leak the stored password.
  if (content.password) {
    const suppliedPassword = formData.get('password')?.toString() || '';
    if (!timeSafeEqual(suppliedPassword, content.password)) {
      return new Response('评论加密文章需要正确密码', { status: 403 });
    }
  }

  // Check if comments are auto-closed due to age
  if (options.commentsAutoClose && options.commentsPostTimeout && content.created) {
    const ageSeconds = Math.floor(Date.now() / 1000) - content.created;
    if (ageSeconds > options.commentsPostTimeout) {
      return new Response('评论已关闭（文章发布时间过长）', { status: 403 });
    }
  }

  let userId = 0;
  let ownerId = content.authorId || 0;

  if (authResult) {
    userId = authResult.uid;
    author = authResult.user.screenName || authResult.user.name || author;
    mail = authResult.user.mail || mail;
    url = authResult.user.url || url;
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

  if (url) {
    const normalizedUrl = normalizeHttpUrl(url);
    if (normalizedUrl === null) {
      return new Response('网站地址格式不正确', { status: 400 });
    }
    url = normalizedUrl;
  }

  // Check referer URL matches the content's URL (anti-spam: ensure comment came from a real page view)
  if (options.commentsCheckReferer) {
    if (!isTrustedCommentReferer(request.headers.get('referer'), options.siteUrl || '')) {
      return new Response('评论来源页 URL 不合法', { status: 403 });
    }
  }

  // Resolve client IP once — used for anti-spam rate-limit and stored with the comment
  const ip = getClientIp(request);

  // These moderation checks depend on normalized identity, but not on each
  // other. Execute only the enabled checks and share one latency wave.
  const [recentComment, approved, parentComment] = await Promise.all([
    options.commentsPostIntervalEnable && !userId
      ? db
      .select({ created: schema.comments.created })
      .from(schema.comments)
      .where(and(
        eq(schema.comments.cid, cid),
        eq(schema.comments.ip, ip)
      ))
      .orderBy(sql`${schema.comments.created} DESC`)
      .limit(1)
      : Promise.resolve([]),
    options.commentsWhitelist && !userId
      ? db.query.comments.findFirst({
          where: and(
            eq(schema.comments.mail, mail),
            eq(schema.comments.status, 'approved')
          ),
        })
      : Promise.resolve(null),
    parent > 0
      ? db.query.comments.findFirst({
          where: and(
            eq(schema.comments.coid, parent),
            eq(schema.comments.cid, cid)
          ),
        })
      : Promise.resolve(null),
  ]);

  if (options.commentsPostIntervalEnable && !userId && recentComment[0]) {
      const elapsed = Math.floor(Date.now() / 1000) - (recentComment[0].created || 0);
      if (elapsed < (options.commentsPostInterval || 60)) {
        return new Response(`评论过于频繁，请等待 ${options.commentsPostInterval - elapsed} 秒后再试`, { status: 429 });
      }
  }

  // Determine comment status
  let status = 'approved';
  if (options.commentsRequireModeration) {
    status = 'waiting';
  }
  if (options.commentsWhitelist && !userId) {
    if (!approved) {
      status = 'waiting';
    }
  }

  if (parent > 0 && !parentComment) {
    return new Response('父评论不存在', { status: 400 });
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
  const protectedCommentData = { ...commentData };

  // CSRF: token must be present, cid-bound, and valid for the target
  // post — for both anonymous and logged-in commenters. The token is
  // generated per-cid at page render time, so cached HTML still works
  // as long as it belongs to the same post.
  if (options.commentsAntiSpam) {
    const submittedToken = formData.get('_')?.toString() || '';
    const valid = submittedToken
      ? await validateCommentToken(submittedToken, options.secret as string, cid)
      : false;
    if (!valid) {
      return new Response('评论来源验证失败', { status: 403 });
    }
  }

  // Apply comment:beforeSave filter — plugins can modify/reject comment data before save.
  // G6-5: catch plugin failures and convert to a 403 reject reason
  // rather than letting them surface as a 500 to the commenter.
  try {
    const filtered = await applyFilter(pluginCtx, 'comment:beforeSave', commentData, {
      request, formData, db, options, isLoggedIn: !!userId,
    });
    commentData = validateFilteredComment(protectedCommentData, filtered);
  } catch (err) {
    if (err instanceof WriteFilterError) {
      return new Response(err.message, { status: 400 });
    }
    console.error({
      event: 'comment_filter_failed',
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return new Response('插件处理评论时出错，请稍后重试', { status: 503 });
  }

  // Check if any plugin rejected the comment (e.g. captcha verification failed)
  if (commentData._rejected) {
    const reason = String(commentData._rejected);
    delete commentData._rejected;
    return new Response(reason, { status: 403 });
  }

  const finalStatus = commentData.status;

  const writeStatements: any[] = [
    db.insert(schema.comments).values(commentData as any).returning({ coid: schema.comments.coid }),
  ];
  if (finalStatus === 'approved') {
    writeStatements.push(
      db.update(schema.contents)
        .set({ commentsNum: sql`${schema.contents.commentsNum} + 1` })
        .where(eq(schema.contents.cid, cid)),
    );
  }
  const [inserted] = await db.batch(writeStatements as [any, ...any[]]);
  if (!inserted.length) return new Response('评论保存失败', { status: 500 });
  const newCoid = inserted[0].coid;
  commentData.coid = newCoid;

  // Trigger comment:afterCreate hook — plugins can act after comment saved
  await doHook(pluginCtx, 'comment:afterCreate', commentData);
  if (parent > 0) {
    await doHook(pluginCtx, 'comment:reply', commentData, { parent });
  }

  // Email notification (fire-and-forget via waitUntil)
  if (finalStatus === 'approved') {
    const notifyP = notifyOnComment({
      pluginCtx,
      db,
      options,
      siteUrl: (options.siteUrl as string) || '',
      permalinkPattern: options.permalinkPattern as string | undefined,
      pagePattern: options.pagePattern as string | undefined,
      comment: {
        coid: newCoid,
        cid,
        author: commentData.author as string | null ?? null,
        mail: commentData.mail as string | null ?? null,
        text: commentData.text as string | null ?? null,
        parent: commentData.parent as number,
        authorId: commentData.authorId as number | null ?? null,
      },
      content: {
        cid: content.cid,
        title: content.title,
        slug: content.slug,
        type: content.type || 'post',
        created: content.created || 0,
        authorId: content.authorId,
      },
      request,
    });
    if (locals.cfContext?.waitUntil) {
      locals.cfContext.waitUntil(notifyP);
    }
  }

  const contentUrl = buildPermalink(
    { cid: content.cid, slug: content.slug, type: content.type, created: content.created },
    options.siteUrl || '',
    options.permalinkPattern as string | undefined,
    options.pagePattern as string | undefined,
  );
  await Promise.all([
    bumpCacheVersion(db),
    purgeContentCache(options.siteUrl || '', cid, { contentUrl }),
  ]);

  // Redirect back to the post. Fall back to the configured permalink (not the
  // hard-coded default path, which may be deprecated); the referer is only
  // used when it is a relative path or same-origin.
  const contentPath = contentUrl.startsWith('http')
    ? new URL(contentUrl).pathname
    : contentUrl;
  let redirectUrl = `${contentPath}#comments`;
  const referer = requestReferer;
  if (referer) {
    redirectUrl = safeCommentRedirectUrl(referer, options.siteUrl || '', request.url, redirectUrl);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  });
};

function isTrustedCommentReferer(referer: string | null, siteUrl: string): boolean {
  if (!referer || !siteUrl) return false;
  try {
    return new URL(referer).origin === new URL(siteUrl).origin;
  } catch {
    return false;
  }
}

function safeCommentRedirectUrl(
  referer: string,
  siteUrl: string,
  requestUrl: string,
  fallback: string,
): string {
  try {
    const refUrl = new URL(referer);
    const trustedOrigins = new Set([new URL(requestUrl).origin]);
    if (siteUrl) trustedOrigins.add(new URL(siteUrl).origin);
    if (!trustedOrigins.has(refUrl.origin)) return fallback;
    return `${refUrl.pathname}${refUrl.search}#comments`;
  } catch {
    return fallback;
  }
}
