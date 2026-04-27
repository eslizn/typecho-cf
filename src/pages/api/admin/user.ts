import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission, hashPassword, generateRandomString, requireAdminCSRF } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403 });
  }

  const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid);
  if (csrfError) return csrfError;

  const formData = await request.formData();
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
      return new Response('请填写完整信息', { status: 400 });
    }
    if (password.length < 6) {
      return new Response('密码长度至少6位', { status: 400 });
    }
    if (password !== confirm) {
      return new Response('两次输入的密码不一致', { status: 400 });
    }

    // Check if name exists
    const existingName = await db.query.users.findFirst({
      where: eq(schema.users.name, name),
    });
    if (existingName) {
      return new Response('用户名已被使用', { status: 409 });
    }

    // Check if mail exists
    const existingMail = await db.query.users.findFirst({
      where: eq(schema.users.mail, mail),
    });
    if (existingMail) {
      return new Response('邮箱已被使用', { status: 409 });
    }

    const hashedPassword = await hashPassword(password);
    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(schema.users).values({
      name,
      password: hashedPassword,
      mail,
      url: url || null,
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
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.uid, uid),
    });
    if (!existing) {
      return new Response('用户不存在', { status: 404 });
    }

    if (!mail) {
      return new Response('邮箱不能为空', { status: 400 });
    }

    const updateData: Record<string, unknown> = {
      mail,
      screenName: screenName || existing.name,
      url: url || null,
      group,
    };

    if (password) {
      if (password.length < 6) {
        return new Response('密码长度至少6位', { status: 400 });
      }
      if (password !== confirm) {
        return new Response('两次输入的密码不一致', { status: 400 });
      }
      updateData.password = await hashPassword(password);
    }

    await db.update(schema.users).set(updateData).where(eq(schema.users.uid, uid));

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/user?uid=${uid}` },
    });
  }

  return new Response('Invalid action', { status: 400 });
};
