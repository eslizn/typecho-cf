import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import {
  verifyPassword,
  generateAuthToken,
  setAuthCookieHeaders,
  generateRandomString,
  hashPassword,
  passwordHashNeedsRehash,
} from '@/lib/auth';
import { LOGIN_ERROR_FLASH_COOKIE, createFlashRedirectHeaders } from '@/lib/flash';
import { applyFilter, doHook, setActivatedPlugins, parseActivatedPlugins, type HookContext } from '@/lib/plugin';
import {
  clearLoginFailures,
  loginLockedUntil,
  readLoginRateLimitConfig,
  recordLoginFailure,
} from '@/lib/login-rate-limit';
import { safeAdminRedirectUrl } from '@/lib/admin-auth';
import { getClientIp, getRequestCoreContextFromLocals, getRequestI18n } from '@/lib/context';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { i18nMessage, type I18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';

const LOGIN_URL = '/admin/login';

/**
 * A pre-computed valid PBKDF2 hash used to run `verifyPassword` against a
 * fixed target when the requested username doesn't exist. The specific
 * password is irrelevant — we discard the return value; we just want the
 * server to spend the same ~50-100 ms so response time doesn't leak
 * whether the account exists.
 *
 * Generated with:
 *   await hashPassword('unreachable-dummy-password-1')
 * Any hash produced by hashPassword() will do; picking a fixed one keeps
 * the dummy path from allocating a fresh salt on every no-user request.
 */
const DUMMY_PASSWORD_HASH =
  '$PBKDF2$100000$0123456789abcdef0123456789abcdef$0000000000000000000000000000000000000000000000000000000000000000';

function redirectWithLoginError(message: string | I18nMessage, request?: Request): Response {
  return new Response(null, {
    status: 302,
    headers: createFlashRedirectHeaders(LOGIN_URL, LOGIN_ERROR_FLASH_COOKIE, message, LOGIN_URL, request),
  });
}

function buildLoginHookFormData(formData: FormData): FormData {
  const safe = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key === 'password' || key === 'pass' || key === 'currentPassword') continue;
    safe.append(key, value);
  }
  return safe;
}

async function notifyLoginFailure(
  pluginCtx: HookContext,
  request: Request,
  reason: 'missing_input' | 'locked' | 'rejected' | 'invalid',
): Promise<void> {
  await doHook(pluginCtx, 'user:login:failure', { request, reason });
}

/**
 * Reject cross-origin POSTs even before we touch the database. The login
 * page is same-origin only; missing Origin/Referer headers are treated
 * as untrusted to avoid `<form enctype=text/plain>` cross-site logins.
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
  let i18n = core?.i18n ?? getRequestI18n(request, options);
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
    await setActivatedPlugins(pluginCtx, activatedIds);
    i18n = getRequestI18n(request, options, pluginCtx.activatedPlugins);
  }
  pluginCtx.i18n = i18n;

  if (!isSameOriginRequest(request, options.siteUrl)) {
    return textError(403, i18nMessage('core.error.forbidden', 'Forbidden'), undefined, i18n);
  }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.auth);
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, inputErrorMessage(error), undefined, i18n);
    throw error;
  }
  const name = formData.get('name')?.toString() || '';
  const password = formData.get('password')?.toString() || '';
  const remember = formData.get('remember')?.toString() === '1';

  // Constrain post-login redirect to /admin/* on the same origin. The form
  // value is a path; safeAdminRedirectUrl expects a URL, so resolve it
  // against siteUrl first.
  const refererInput = formData.get('referer')?.toString() || '/admin/';
  const refererAbsolute = (() => {
    if (!options.siteUrl) return refererInput;
    try { return new URL(refererInput, options.siteUrl).toString(); } catch { return options.siteUrl; }
  })();
  const referer = safeAdminRedirectUrl(refererAbsolute, options.siteUrl || '', '/admin/');

  if (!name) {
    await notifyLoginFailure(pluginCtx, request, 'missing_input');
    return redirectWithLoginError(i18nMessage('auth.usernameRequired', 'Please enter your username.'), request);
  }
  if (!password) {
    await notifyLoginFailure(pluginCtx, request, 'missing_input');
    return redirectWithLoginError(i18nMessage('auth.passwordRequired', 'Please enter your password.'), request);
  }

  // ── Brute-force throttle ────────────────────────────────────────────────
  const rateConfig = readLoginRateLimitConfig(options as unknown as Record<string, unknown>);
  const ip = getClientIp(request);
  // The lock row and user row are independent. Fetch both in parallel so a
  // normal login pays one D1 latency wave before PBKDF2 verification.
  const [lockedUntil, user] = await Promise.all([
    loginLockedUntil(db, ip, rateConfig),
    db.query.users.findFirst({ where: eq(schema.users.name, name) }),
  ]);
  if (lockedUntil > 0) {
    const remaining = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    const headers = createFlashRedirectHeaders(LOGIN_URL, LOGIN_ERROR_FLASH_COOKIE, i18nMessage('auth.loginLocked', 'Too many failed login attempts. Try again in {seconds} seconds.', { seconds: remaining }), LOGIN_URL, request);
    headers.set('Retry-After', String(remaining));
    await notifyLoginFailure(pluginCtx, request, 'locked');
    return new Response(null, { status: 302, headers });
  }

  const loginContext = await applyFilter(pluginCtx, 'user:login:before', {}, {
    request,
    formData: buildLoginHookFormData(formData),
    options: { ...options, secret: undefined },
    i18n,
  });
  const rejectedReason = loginContext && typeof loginContext === 'object'
    ? (loginContext as { _rejected?: unknown })._rejected
    : undefined;
  if (rejectedReason) {
    await notifyLoginFailure(pluginCtx, request, 'rejected');
    return redirectWithLoginError(String(rejectedReason), request);
  }

  if (!user) {
    // Run a dummy PBKDF2 against a fixed hash so response time reveals
    // nothing about whether the account exists. verifyPassword is the
    // dominant cost of a real login (~50-100 ms); without this branch a
    // no-user reply arrives in < 10 ms and enumeration becomes trivial.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    await recordLoginFailure(db, ip, rateConfig);
    await notifyLoginFailure(pluginCtx, request, 'invalid');
    return redirectWithLoginError(i18nMessage('auth.invalidCredentials', 'Invalid username or password.'), request);
  }

  const valid = await verifyPassword(password, user.password || '');
  if (valid === 'needs_reset') {
    await recordLoginFailure(db, ip, rateConfig);
    await notifyLoginFailure(pluginCtx, request, 'invalid');
    return redirectWithLoginError(i18nMessage('auth.passwordNeedsReset', 'This password format must be upgraded. Use password reset to continue.'), request);
  }
  if (valid !== true) {
    await recordLoginFailure(db, ip, rateConfig);
    await notifyLoginFailure(pluginCtx, request, 'invalid');
    return redirectWithLoginError(i18nMessage('auth.invalidCredentials', 'Invalid username or password.'), request);
  }

  // Successful login → reset failure counter for this IP.
  await clearLoginFailures(db, ip);

  // Opportunistic password upgrade: if the stored hash uses fewer
  // PBKDF2 iterations than the current recommendation, rehash with the
  // user-supplied plaintext (which we have right here, post-verification).
  // Failure to upgrade is non-fatal — we only log and continue.
  let upgradedPassword: string | null = null;
  if (passwordHashNeedsRehash(user.password || '')) {
    try {
      upgradedPassword = await hashPassword(password);
    } catch (err) {
      console.error('[login] Password rehash failed:', err);
    }
  }

  const newAuthCode = generateRandomString(32);
  await db
    .update(schema.users)
    .set({
      authCode: newAuthCode,
      logged: Math.floor(Date.now() / 1000),
      ...(upgradedPassword ? { password: upgradedPassword } : {}),
    })
    .where(eq(schema.users.uid, user.uid));

  const hash = await generateAuthToken(user.uid, newAuthCode, options.secret);
  const token = hash.split(':')[1];
  const cookieHeaders = setAuthCookieHeaders(user.uid, token, remember ? 30 * 24 * 3600 : 0, request);

  const headers = new Headers();
  headers.set('Location', referer);
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }

  await doHook(pluginCtx, 'user:login:success', {
    request,
    remember,
    user: {
      uid: user.uid,
      name: user.name,
      mail: user.mail,
      screenName: user.screenName,
      url: user.url,
      group: user.group,
    },
  });

  return new Response(null, { status: 302, headers });
};
