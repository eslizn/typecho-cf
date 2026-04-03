import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { hashPassword, generateRandomString, setAuthCookieHeaders, generateAuthToken } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  if (!options.allowRegister) {
    return new Response('注册已关闭', { status: 403 });
  }

  const formData = await request.formData();
  const name = formData.get('name')?.toString()?.trim() || '';
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';

  if (!name || !mail || !password) {
    return new Response('请填写完整信息', { status: 400 });
  }

  if (name.length < 2 || name.length > 32) {
    return new Response('用户名长度需在2-32个字符之间', { status: 400 });
  }

  if (password.length < 6) {
    return new Response('密码长度至少6个字符', { status: 400 });
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

  const result = await db.insert(schema.users).values({
    name,
    mail,
    password: hashedPassword,
    screenName: name,
    created: now,
    activated: now,
    logged: now,
    group: 'subscriber',
    authCode,
  }).returning({ uid: schema.users.uid });

  const uid = result[0]?.uid;
  if (!uid) {
    return new Response('注册失败', { status: 500 });
  }

  // Auto login
  const hash = await generateAuthToken(uid, authCode, options.secret);
  const token = hash.split(':')[1];
  const cookieHeaders = setAuthCookieHeaders(uid, token);

  const headers = new Headers();
  headers.set('Location', '/');
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
};
