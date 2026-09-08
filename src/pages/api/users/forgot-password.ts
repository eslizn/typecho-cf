import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { generateResetToken, hashResetToken, RESET_TOKEN_EXPIRY_SEC } from '@/lib/auth';
import { createMailI18n, sendMail } from '@/lib/mail';
import { escapeHtml } from '@/lib/escape';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { getClientIp, getRequestI18n } from '@/lib/context';
import { setActivatedPlugins, parseActivatedPlugins, type HookContext } from '@/lib/plugin';
import { and, eq, lte } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = async ({ request }) => {
  const coreI18n = createCoreRequestI18n(request).i18n;
  // Origin check — prevent CSRF. Missing origin is rejected outright
  // because browsers send Origin on cross-origin form POSTs; anonymous
  // tools can't bypass without explicit opt-in.
  const origin = request.headers.get('origin');
  if (!origin) return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, coreI18n);
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    if (originUrl.origin !== requestUrl.origin) {
      return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, coreI18n);
    }
  } catch { return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, coreI18n); }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm);
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, inputErrorMessage(error), undefined, coreI18n);
    throw error;
  }

  const ip = getClientIp(request);
  if (!trackSlidingWindow(`forgot-pw:${ip}`, { windowSeconds: 3600, maxRequests: 3 })) {
    return textError(429, i18nMessage('auth.resetRateLimited', 'Too many requests. Please try again later.'), { 'Retry-After': '3600' }, coreI18n);
  }

  const email = formData.get('email')?.toString()?.trim() || '';

  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const i18n = getRequestI18n(request, options);

  // Always return the same success page — don't leak whether email exists
  const successPage = new Response(
    `<!DOCTYPE html><html lang="${escapeHtml(i18n.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(i18n.t('admin.page.resetPassword', {}, 'Set a new password'))}</title></head><body><p>${escapeHtml(i18n.t('auth.resetEmailSent', {}, 'If the email is registered, a reset link has been sent. Check your inbox.'))}</p><p><a href="/admin/login">${escapeHtml(i18n.t('admin.auth.backToLogin', {}, 'Back to login'))}</a></p></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

  if (!email) return successPage;

  // Per-email throttle (1 per hour)
  const [[existingRequest], [user]] = await db.batch([
    db.select().from(schema.passwordResetRequests)
      .where(eq(schema.passwordResetRequests.email, email)).limit(1),
    db.select({ uid: schema.users.uid, mail: schema.users.mail }).from(schema.users)
      .where(eq(schema.users.mail, email)).limit(1),
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  if (existingRequest && nowSec - existingRequest.lastSentAt < 3600) return successPage;
  if (!user) return successPage;

  // Store only a hash of the pending token. Requesting a reset must not
  // invalidate active sessions; authCode is refreshed only after success.
  const token = generateResetToken();
  const tokenHash = await hashResetToken(token);
  const expiresAt = nowSec + RESET_TOKEN_EXPIRY_SEC;
  const [, claimed] = await db.batch([
    db.insert(schema.passwordResetRequests).values({
      email,
      lastSentAt: 0,
    }).onConflictDoNothing(),
    db.update(schema.passwordResetRequests).set({
      lastSentAt: nowSec,
      uid: user.uid,
      tokenHash,
      expiresAt,
    }).where(and(
      eq(schema.passwordResetRequests.email, email),
      lte(schema.passwordResetRequests.lastSentAt, nowSec - 3600),
    )).returning({ email: schema.passwordResetRequests.email }),
  ] as const);
  // Another request won the per-email issuance claim.
  if (!claimed.length) return successPage;

  // Send mail — best-effort; if no adapter is installed, mail will fail silently
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));

  const resetUrl = `${urls.siteUrl}/admin/reset-password?token=${encodeURIComponent(token)}`;
  const mailI18n = createMailI18n(options, pluginCtx.activatedPlugins);
  const mailSiteTitle = String(options.title || 'Typecho');
  const mailExpiry = mailI18n.t('mail.reset.expiry', {}, 'This link is valid for 1 hour.');
  const mailIgnore = mailI18n.t('mail.reset.ignore', {}, 'If you did not request this, you can ignore this email.');
  const mailResult = await sendMail(pluginCtx, {
    to: email,
    subject: mailI18n.t('mail.reset.subject', { siteTitle: mailSiteTitle }, `${mailSiteTitle} - Password reset`),
    html: `<p>${escapeHtml(mailI18n.t('mail.reset.greeting', {}, 'Hello,'))}</p><p>${escapeHtml(mailI18n.t('mail.reset.instructions', {}, 'We received a request to reset your password. Use the link below to set a new password:'))}</p><p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p><p>${escapeHtml(mailExpiry)}</p><p>${escapeHtml(mailIgnore)}</p>`,
    text: `${mailI18n.t('mail.reset.greeting', {}, 'Hello,')}\n\n${mailI18n.t('mail.reset.instructions', {}, 'We received a request to reset your password. Use the link below to set a new password:')}\n${resetUrl}\n\n${mailExpiry}\n${mailIgnore}`,
  }, { request, options, reason: 'password-reset', i18n: mailI18n });

  if (!mailResult.sent && existingRequest) {
    await db.update(schema.passwordResetRequests).set({
      lastSentAt: existingRequest.lastSentAt,
      uid: existingRequest.uid,
      tokenHash: existingRequest.tokenHash,
      expiresAt: existingRequest.expiresAt,
    }).where(and(
      eq(schema.passwordResetRequests.email, email),
      eq(schema.passwordResetRequests.tokenHash, tokenHash),
    ));
  } else if (!mailResult.sent) {
    await db.delete(schema.passwordResetRequests)
      .where(and(
        eq(schema.passwordResetRequests.email, email),
        eq(schema.passwordResetRequests.tokenHash, tokenHash),
      ));
  }

  return successPage;
};
