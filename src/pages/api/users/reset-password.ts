import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { parseResetToken, hashPassword, generateRandomString, hashResetToken } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH, REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { and, eq, gte, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { getRequestI18n } from '@/lib/context';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';
import { escapeHtml } from '@/lib/escape';

export const POST: APIRoute = async ({ request }) => {
  const coreI18n = createCoreRequestI18n(request).i18n;
  let i18n = coreI18n;
  // Origin check — prevent CSRF
  const origin = request.headers.get('origin');
  if (!origin) return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, i18n);
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    if (originUrl.origin !== requestUrl.origin) {
      return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, i18n);
    }
  } catch { return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, i18n); }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.auth);
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, inputErrorMessage(error), undefined, i18n);
    throw error;
  }
  const token = formData.get('token')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';
  const confirm = formData.get('confirm')?.toString() || '';

  const db = getDb(env.DB);
  const options = await loadOptions(db);
  i18n = getRequestI18n(request, options);

  if (!token || !password) {
    return textError(400, i18nMessage('auth.resetIncomplete', 'Required reset parameters are missing.'), undefined, i18n);
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return textError(400, i18nMessage('auth.resetPasswordTooShort', 'The password must be at least {count} characters.', { count: PASSWORD_MIN_LENGTH }), undefined, i18n);
  }

  // Validate confirmation before looking up or mutating the one-time token.
  if (password !== confirm) {
    return textError(400, i18nMessage('auth.resetMismatch', 'The two passwords do not match.'), undefined, i18n);
  }

  const parsed = await parseResetToken(token, db);

  if (!parsed.valid || !parsed.uid) {
    const msg = parsed.error === 'expired'
      ? i18n.t('auth.resetExpired', {}, 'The reset link has expired.')
      : i18n.t('auth.resetInvalid', {}, 'The reset link is invalid or has already been used.');
    return new Response(
      `<!DOCTYPE html><html lang="${escapeHtml(i18n.locale)}"><head><meta charset="utf-8"><title>${escapeHtml(i18n.t('admin.error.operationFailed', {}, 'Operation failed'))}</title></head><body><p>${escapeHtml(msg)}</p><p><a href="/admin/login">${escapeHtml(i18n.t('admin.auth.backToLogin', {}, 'Back to login'))}</a></p></body></html>`,
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  // Hash new password + generate fresh authCode (invalidates all sessions, decision #4)
  const newHash = await hashPassword(password);
  const newAuthCode = generateRandomString(32);
  const tokenHash = await hashResetToken(token);
  const nowSec = Math.floor(Date.now() / 1000);

  const [updated] = await db.batch([
    db.update(schema.users).set({
      password: newHash,
      authCode: newAuthCode,
    }).where(and(
      eq(schema.users.uid, parsed.uid),
      sql`EXISTS (
        SELECT 1 FROM ${schema.passwordResetRequests}
        WHERE ${schema.passwordResetRequests.uid} = ${parsed.uid}
          AND ${schema.passwordResetRequests.tokenHash} = ${tokenHash}
          AND ${schema.passwordResetRequests.expiresAt} >= ${nowSec}
      )`,
    )).returning({ uid: schema.users.uid }),
    db.update(schema.passwordResetRequests).set({
      tokenHash: null,
      expiresAt: null,
    }).where(and(
      eq(schema.passwordResetRequests.uid, parsed.uid),
      eq(schema.passwordResetRequests.tokenHash, tokenHash),
      gte(schema.passwordResetRequests.expiresAt, nowSec),
    )),
  ] as const);

  if (!updated.length) {
    return textError(400, i18nMessage('auth.resetInvalid', 'The reset link is invalid or has already been used.'), undefined, i18n);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login?reset=success' },
  });
};
