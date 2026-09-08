import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { readAdminFormOrError } from '@/lib/input';
import { normalizeHttpUrl } from '@/lib/url';
import { and, eq, ne, sql } from 'drizzle-orm';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;
  const db = auth.db;

  const formData = await readAdminFormOrError(request, undefined, auth.i18n);
  if (formData instanceof Response) return formData;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, auth.i18n);
  const action = formData.get('do')?.toString() || 'create';
  const uid = parseInt(formData.get('uid')?.toString() || '0', 10);
  const name = formData.get('name')?.toString()?.trim() || '';
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const screenName = formData.get('screenName')?.toString()?.trim() || '';
  const url = formData.get('url')?.toString()?.trim() || '';
  const groupInput = formData.get('group')?.toString() || 'subscriber';
  const VALID_GROUPS = ['administrator', 'editor', 'contributor', 'subscriber'];
  const group = VALID_GROUPS.includes(groupInput) ? groupInput : 'subscriber';
  const password = formData.get('password')?.toString() || '';
  const confirm = formData.get('confirm')?.toString() || '';

  if (action === 'create') {
    if (!name || !mail || !password) {
      return error(400, 'admin.user.incomplete', {}, 'Please complete all required fields.');
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return error(400, 'admin.user.passwordTooShort', { count: PASSWORD_MIN_LENGTH }, 'The password must be at least {count} characters.');
    }
    if (password !== confirm) {
      return error(400, 'admin.user.passwordMismatch', {}, 'The two passwords do not match.');
    }

    const [[[existingName], [existingMail]], hashedPassword] = await Promise.all([
      db.batch([
        db.select({ uid: schema.users.uid }).from(schema.users)
          .where(eq(schema.users.name, name)).limit(1),
        db.select({ uid: schema.users.uid }).from(schema.users)
          .where(eq(schema.users.mail, mail)).limit(1),
      ]),
      hashPassword(password),
    ]);
    if (existingName) {
      return error(409, 'admin.user.usernameTaken', {}, 'This username is already in use.');
    }
    if (existingMail) {
      return error(409, 'admin.user.emailTaken', {}, 'This email address is already in use.');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return error(400, 'admin.user.emailInvalid', {}, 'The email address is invalid.');
    }

    let normalizedUrl: string | null = null;
    if (url) {
      const parsed = normalizeHttpUrl(url);
      if (parsed === null) return error(400, 'admin.user.urlInvalid', {}, 'The profile URL is invalid.');
      normalizedUrl = parsed;
    }

    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(schema.users).values({
      name,
      password: hashedPassword,
      mail,
      url: normalizedUrl,
      screenName: screenName || name,
      created: now,
      activated: now,
      logged: 0,
      group,
      authCode,
    });

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/manage-users' },
    });
  }

  if (action === 'update' && uid) {
    const [[existing], [existingMail], adminCounts] = await db.batch([
      db.select().from(schema.users).where(eq(schema.users.uid, uid)).limit(1),
      db.select({ uid: schema.users.uid }).from(schema.users)
        .where(and(eq(schema.users.mail, mail), ne(schema.users.uid, uid))).limit(1),
      db.select({ count: sql<number>`count(*)` }).from(schema.users)
        .where(eq(schema.users.group, 'administrator')),
    ]);
    if (!existing) {
      return error(404, 'admin.user.notFound', {}, 'The user does not exist.');
    }

    if (!mail) {
      return error(400, 'admin.user.emailRequired', {}, 'Email is required.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return error(400, 'admin.user.emailInvalid', {}, 'The email address is invalid.');
    }

    if (existingMail) {
      return error(409, 'admin.user.emailTaken', {}, 'This email address is already in use.');
    }

    if (existing.group === 'administrator' && group !== 'administrator' && (adminCounts[0]?.count || 0) <= 1) {
      return error(400, 'admin.user.lastAdmin', {}, 'The last administrator cannot be demoted.');
    }

    let normalizedUrl: string | null = null;
    if (url) {
      const parsed = normalizeHttpUrl(url);
      if (parsed === null) return error(400, 'admin.user.urlInvalid', {}, 'The profile URL is invalid.');
      normalizedUrl = parsed;
    }

    const updateData: Record<string, unknown> = {
      mail,
      screenName: screenName || existing.name,
      url: normalizedUrl,
      group,
    };

    if (password) {
      if (password.length < PASSWORD_MIN_LENGTH) {
        return error(400, 'admin.user.passwordTooShort', { count: PASSWORD_MIN_LENGTH }, 'The password must be at least {count} characters.');
      }
      if (password !== confirm) {
        return error(400, 'admin.user.passwordMismatch', {}, 'The two passwords do not match.');
      }
      updateData.password = await hashPassword(password);
      // Password changes revoke every existing session for this user.
      updateData.authCode = generateRandomString(32);
    }

    await db.update(schema.users).set(updateData).where(eq(schema.users.uid, uid));

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/user?uid=${uid}` },
    });
  }

  return error(400, 'admin.user.invalidAction', {}, 'Invalid action.');
};
