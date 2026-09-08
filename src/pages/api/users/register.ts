import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH, REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, readBoundedFormData } from '@/lib/input';
import { REGISTER_NOTICE_FLASH_COOKIE, createFlashRedirectHeaders } from '@/lib/flash';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getRequestCoreContextFromLocals } from '@/lib/context';
import { applyFilter, doHook, parseActivatedPlugins, setActivatedPlugins, type HookContext } from '@/lib/plugin';

/**
 * Reject cross-origin POSTs. Tightening this beyond the global CSRF
 * extraction (which only covers admin endpoints) ensures an attacker can
 * never silently provision an account in a victim's browser session via
 * a third-party page.
 */
function isSameOriginRequest(request: Request, siteUrl: string): boolean {
  if (!siteUrl) return false;
  const expected = (() => {
    try { return new URL(siteUrl).origin; } catch { return ''; }
  })();
  if (!expected) return false;
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

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));

  if (!options.allowRegister) {
    return new Response('注册已关闭', { status: 403 });
  }

  if (!isSameOriginRequest(request, options.siteUrl)) {
    return new Response('Forbidden', { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm);
  } catch (error) {
    if (error instanceof InputError) return new Response(error.message, { status: error.status });
    throw error;
  }
  const name = formData.get('name')?.toString()?.trim() || '';
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';

  if (!name || !mail || !password) {
    return new Response('请填写完整信息', { status: 400 });
  }

  if (name.length < 2 || name.length > 32) {
    return new Response('用户名长度需在2-32个字符之间', { status: 400 });
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return new Response(`密码长度至少${PASSWORD_MIN_LENGTH}个字符`, { status: 400 });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return new Response('邮箱格式不正确', { status: 400 });
  }

  let registrationData: { name: string; mail: string; screenName: string } = {
    name,
    mail,
    screenName: name,
  };
  try {
    const filtered = await applyFilter(pluginCtx, 'user:register:before', { ...registrationData }, {
      request,
      db,
      options: { ...options, secret: undefined },
      passwordLength: password.length,
    });
    if (filtered?._rejected) {
      return new Response(String(filtered._rejected), { status: 403 });
    }
    if (!filtered || typeof filtered !== 'object') {
      return new Response('注册信息无效', { status: 400 });
    }
    registrationData = {
      name: typeof filtered.name === 'string' ? filtered.name.trim() : '',
      mail: typeof filtered.mail === 'string' ? filtered.mail.trim() : '',
      screenName: typeof filtered.screenName === 'string' ? filtered.screenName.trim() : '',
    };
  } catch (error) {
    console.error({
      event: 'register_filter_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return new Response('插件处理注册信息时出错，请稍后重试', { status: 503 });
  }

  if (registrationData.name.length < 2 || registrationData.name.length > 32) {
    return new Response('用户名长度需在2-32个字符之间', { status: 400 });
  }
  if (!registrationData.mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registrationData.mail)) {
    return new Response('邮箱格式不正确', { status: 400 });
  }
  if (registrationData.screenName.length > 150) {
    return new Response('昵称过长', { status: 400 });
  }

  const [[existingName], [existingMail]] = await db.batch([
    db.select({ uid: schema.users.uid }).from(schema.users)
      .where(eq(schema.users.name, registrationData.name)).limit(1),
    db.select({ uid: schema.users.uid }).from(schema.users)
      .where(eq(schema.users.mail, registrationData.mail)).limit(1),
  ]);
  if (existingName) {
    return new Response('用户名已被使用', { status: 409 });
  }
  if (existingMail) {
    return new Response('邮箱已被使用', { status: 409 });
  }

  const hashedPassword = await hashPassword(password);
  const authCode = generateRandomString(32);
  const now = Math.floor(Date.now() / 1000);

  const result = await db.insert(schema.users).values({
    name: registrationData.name,
    mail: registrationData.mail,
    password: hashedPassword,
    screenName: registrationData.screenName || registrationData.name,
    created: now,
    activated: now,
    logged: 0,
    group: 'subscriber',
    authCode,
  }).returning({ uid: schema.users.uid });

  if (!result[0]?.uid) {
    return new Response('注册失败', { status: 500 });
  }

  await doHook(pluginCtx, 'user:register:after', {
    request,
    user: {
      uid: result[0].uid,
      name: registrationData.name,
      mail: registrationData.mail,
      screenName: registrationData.screenName || registrationData.name,
      group: 'subscriber',
      created: now,
      activated: now,
    },
  });

  // No auto-login: redirect to the login page with a success flash. This
  // closes the cross-site session-fixation surface where a third-party
  // page could provision an attacker-owned account into the victim's
  // browser without their awareness.
  return new Response(null, {
    status: 302,
    headers: createFlashRedirectHeaders('/admin/login', REGISTER_NOTICE_FLASH_COOKIE, '注册成功，请使用新账号登录', '/admin/login', request),
  });
};
