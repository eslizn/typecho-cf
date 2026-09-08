import type { APIRoute } from 'astro';
import { schema } from '@/db';
import {
  clearAuthCookieHeaders,
  generateRandomString,
  hashPassword,
  verifyPassword,
} from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { readAdminFormOrError } from '@/lib/input';
import { normalizeHttpUrl } from '@/lib/url';
import { eq, and, ne } from 'drizzle-orm';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'visitor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await readAdminFormOrError(request, undefined, auth.i18n);
  if (formData instanceof Response) return formData;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, auth.i18n);
  const screenName = formData.get('screenName')?.toString()?.trim() || auth.user.name;
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const url = formData.get('url')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() || '';
  const currentPassword = formData.get('currentPassword')?.toString() || '';

  if (!mail) return error(400, 'admin.profile.emailRequired', {}, 'Email is required.');

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return error(400, 'admin.profile.emailInvalid', {}, 'The email address is invalid.');
  }

  // Check email uniqueness (exclude current user)
  const existingMail = await auth.db.query.users.findFirst({
    where: and(eq(schema.users.mail, mail), ne(schema.users.uid, auth.uid)),
  });
  if (existingMail) {
    return error(409, 'admin.profile.emailTaken', {}, 'This email address is already used by another user.');
  }

  const updateData: Record<string, unknown> = {
    screenName,
    mail,
    url: null,
  };

  if (url) {
    const normalizedUrl = normalizeHttpUrl(url);
    if (normalizedUrl === null) {
      return error(400, 'admin.profile.urlInvalid', {}, 'The profile URL is invalid.');
    }
    updateData.url = normalizedUrl;
  }

  if (password) {
    if (!currentPassword) {
      return error(400, 'admin.profile.currentPasswordRequired', {}, 'Enter your current password.');
    }
    if (!auth.user.password || await verifyPassword(currentPassword, auth.user.password) !== true) {
      return error(403, 'admin.profile.currentPasswordInvalid', {}, 'The current password is incorrect.');
    }
    if (password !== passwordConfirm) {
      return error(400, 'admin.profile.passwordMismatch', {}, 'The two passwords do not match.');
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return error(400, 'admin.profile.passwordTooShort', { count: PASSWORD_MIN_LENGTH }, 'The password must be at least {count} characters.');
    }
    updateData.password = await hashPassword(password);
    updateData.authCode = generateRandomString(32);
  }

  await auth.db.update(schema.users).set(updateData).where(eq(schema.users.uid, auth.uid));

  if (password) {
    const headers = new Headers({ Location: '/admin/login?password=changed' });
    for (const cookie of clearAuthCookieHeaders(request)) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers });
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/profile' } });
};
