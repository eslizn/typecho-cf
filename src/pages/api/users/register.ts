import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { REGISTER_NOTICE_FLASH_COOKIE, createFlashRedirectHeaders } from '@/lib/flash';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

/**
 * Reject cross-origin POSTs. Tightening this beyond the global CSRF
 * extraction (which only covers admin endpoints) ensures an attacker can
 * never silently provision an account in a victim's browser session via
 * a third-party page.
 */
function isSameOriginRequest(request: Request, siteUrl: string): boolean {
  if (!siteUrl) return true;
  const expected = (() => {
    try { return new URL(siteUrl).origin; } catch { return ''; }
  })();
  if (!expected) return true;
  const headerCheck = (raw: string | null) => {
    if (!raw) return null;
    try { return new URL(raw).origin === expected; } catch { return false; }
  };
  const origin = headerCheck(request.headers.get('origin'));
  if (origin !== null) return origin;
  const referer = headerCheck(request.headers.get('referer'));
  if (referer !== null) return referer;
  return false;
}

export const POST: APIRoute = async ({ request }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  if (!options.allowRegister) {
    return new Response('注册已关闭', { status: 403 });
  }

  if (!isSameOriginRequest(request, options.siteUrl)) {
    return new Response('Forbidden', { status: 403 });
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

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return new Response('邮箱格式不正确', { status: 400 });
  }

  const existingName = await db.query.users.findFirst({
    where: eq(schema.users.name, name),
  });
  if (existingName) {
    return new Response('用户名已被使用', { status: 409 });
  }

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
    logged: 0,
    group: 'subscriber',
    authCode,
  }).returning({ uid: schema.users.uid });

  if (!result[0]?.uid) {
    return new Response('注册失败', { status: 500 });
  }

  // No auto-login: redirect to the login page with a success flash. This
  // closes the cross-site session-fixation surface where a third-party
  // page could provision an attacker-owned account into the victim's
  // browser without their awareness.
  return new Response(null, {
    status: 302,
    headers: createFlashRedirectHeaders('/admin/login', REGISTER_NOTICE_FLASH_COOKIE, '注册成功，请使用新账号登录', '/admin/login', request),
  });
};
