import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, validateCommentToken, timeSafeEqual } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook, type HookContext } from '@/lib/plugin';
import { bumpCacheVersion, purgeContentCache } from '@/lib/cache';
import { getClientIp, getRequestCoreContextFromLocals, getRequestI18n } from '@/lib/context';
import { notifyOnComment } from '@/lib/comment-email';
import { buildPermalink } from '@/lib/content';
import { normalizeHttpUrl } from '@/lib/url';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { validateFilteredComment, WriteFilterError } from '@/lib/write-filter';
import { textError } from '@/lib/http';
import { i18nMessage } from '@/lib/i18n';

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  let i18n = core?.i18n ?? getRequestI18n(request, options);
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, i18n);

  if (!isSameOriginRequest(request, options.siteUrl || '')) {
    return error(403, 'core.error.forbidden', {}, 'Forbidden');
  }
  const requestReferer = request.headers.get('referer');
  if (requestReferer && !isTrustedCommentReferer(requestReferer, options.siteUrl || '')) {
    return error(403, 'comment.refererInvalid', {}, 'The comment source URL is invalid.');
  }

  // Load activated plugins
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
    await setActivatedPlugins(pluginCtx, activatedIds);
  }
  i18n = core?.i18n ?? getRequestI18n(request, options, pluginCtx.activatedPlugins);
  pluginCtx.i18n = i18n;

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm);
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, inputErrorMessage(error), undefined, i18n);
    throw error;
  }
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);
  const parent = parseInt(formData.get('parent')?.toString() || '0', 10);
  const text = formData.get('text')?.toString()?.trim() || '';
  let author = formData.get('author')?.toString()?.trim() || '';
  let mail = formData.get('mail')?.toString()?.trim() || '';
  let url = formData.get('url')?.toString()?.trim() || '';

  if (!cid || !text) {
    return error(400, 'comment.textRequired', {}, 'Comment text is required.');
  }

  // Limit comment text length
  if (text.length > 10000) {
    return error(400, 'comment.textTooLong', {}, 'Comment text is too long.');
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
    return error(404, 'comment.contentNotFound', {}, 'The post does not exist.');
  }

  const isPublicContent =
    (content.type === 'post' || content.type === 'page') &&
    (content.status === 'publish' || content.status === 'hidden');
  if (!isPublicContent) {
    return error(403, 'comment.targetUnavailable', {}, 'Comments are not available for this content.');
  }

  if (content.allowComment !== '1') {
    return error(403, 'comment.closed', {}, 'Comments are closed.');
  }

  // Encrypted-post gate: allow commenting only when the submitter has
  // presented the correct password. The frontend post/page form injects
  // a hidden `password` field on the comment form so the same value that
  // decrypted the post authenticates the comment. Use a constant-time
  // comparator so response latency doesn't leak the stored password.
  if (content.password) {
    const suppliedPassword = formData.get('password')?.toString() || '';
    if (!timeSafeEqual(suppliedPassword, content.password)) {
      return error(403, 'comment.passwordRequired', {}, 'The correct post password is required to comment.');
    }
  }

  // Check if comments are auto-closed due to age
  if (options.commentsAutoClose && options.commentsPostTimeout && content.created) {
    const ageSeconds = Math.floor(Date.now() / 1000) - content.created;
    if (ageSeconds > options.commentsPostTimeout) {
      return error(403, 'comment.autoClosed', {}, 'Comments are closed because this post is too old.');
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
      return error(400, 'comment.authorRequired', {}, 'Please enter your name.');
    }
    if (options.commentsRequireMail && !mail) {
      return error(400, 'comment.emailRequired', {}, 'Please enter your email address.');
    }
    if (options.commentsRequireURL && !url) {
      return error(400, 'comment.websiteRequired', {}, 'Please enter your website URL.');
    }
    // Basic email format validation
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return error(400, 'comment.emailInvalid', {}, 'The email address is invalid.');
    }
  }

  if (url) {
    const normalizedUrl = normalizeHttpUrl(url);
    if (normalizedUrl === null) {
      return error(400, 'comment.websiteInvalid', {}, 'The website URL is invalid.');
    }
    url = normalizedUrl;
  }

  // Check referer URL matches the content's URL (anti-spam: ensure comment came from a real page view)
  if (options.commentsCheckReferer) {
    if (!isTrustedCommentReferer(request.headers.get('referer'), options.siteUrl || '')) {
      return error(403, 'comment.refererInvalid', {}, 'The comment source URL is invalid.');
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
        return error(429, 'comment.rateLimited', { seconds: options.commentsPostInterval - elapsed }, 'Comments are being posted too quickly. Try again in {seconds} seconds.');
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
    return error(400, 'comment.parentNotFound', {}, 'The parent comment does not exist.');
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
      return error(403, 'comment.csrfFailed', {}, 'Comment verification failed.');
    }
  }

  // Apply comment:beforeSave filter — plugins can modify/reject comment data before save.
  // G6-5: catch plugin failures and convert to a 403 reject reason
  // rather than letting them surface as a 500 to the commenter.
  try {
    const filtered = await applyFilter(pluginCtx, 'comment:beforeSave', commentData, {
      request, formData, db, options, isLoggedIn: !!userId, i18n,
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
    return error(503, 'comment.pluginFailed', {}, 'A plugin failed while processing the comment. Please try again later.');
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
  if (!inserted.length) return error(500, 'comment.saveFailed', {}, 'The comment could not be saved.');
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
