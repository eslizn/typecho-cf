import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hashPassword, requireAdminCSRF } from '@/lib/auth';
import { eq, and, ne } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth) return new Response('Unauthorized', { status: 401 });

  const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid);
  if (csrfError) return csrfError;

  const formData = await request.formData();
  const screenName = formData.get('screenName')?.toString()?.trim() || auth.user.name;
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const url = formData.get('url')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() || '';

  if (!mail) return new Response('邮箱不能为空', { status: 400 });

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return new Response('邮箱格式不正确', { status: 400 });
  }

  // Check email uniqueness (exclude current user)
  const existingMail = await db.query.users.findFirst({
    where: and(eq(schema.users.mail, mail), ne(schema.users.uid, auth.uid)),
  });
  if (existingMail) {
    return new Response('邮箱已被其他用户使用', { status: 409 });
  }

  const updateData: Record<string, unknown> = {
    screenName,
    mail,
    url: url || null,
  };

  if (password) {
    if (password !== passwordConfirm) {
      return new Response('两次输入的密码不一致', { status: 400 });
    }
    if (password.length < 6) {
      return new Response('密码长度至少6位', { status: 400 });
    }
    updateData.password = await hashPassword(password);
  }

  await db.update(schema.users).set(updateData).where(eq(schema.users.uid, auth.uid));

  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/profile' },
  });
};
