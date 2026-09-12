import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH, REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { REGISTER_NOTICE_FLASH_COOKIE, createFlashRedirectHeaders } from '@/lib/flash';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getRequestCoreContextFromLocals, getRequestI18n } from '@/lib/context';
import { applyFilter, doHook, parseActivatedPlugins, setActivatedPlugins, type HookContext } from '@/lib/plugin';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';
// Same-origin enforcement lives in one place (src/lib/admin-auth.ts) so a
// future tightening of the check cannot miss this public endpoint.
import { isSameOriginRequest } from '@/lib/admin-auth';
import { createRequestCapabilityRuntime } from '@/lib/request-capability';

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  let i18n = core?.i18n ?? getRequestI18n(request, options);
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) {
    await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));
    i18n = getRequestI18n(request, options, pluginCtx.activatedPlugins);
    pluginCtx.capabilityRuntime = createRequestCapabilityRuntime({
      request,
      db,
      options,
      activatedPlugins: pluginCtx.activatedPlugins,
      activationGeneration: pluginCtx.activationGeneration,
    });
  }
  pluginCtx.i18n = i18n;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, i18n);

  if (!options.allowRegister) {
    return error(403, 'auth.registrationClosed', {}, 'Registration is closed.');
  }

  if (!isSameOriginRequest(request, options.siteUrl)) {
    return error(403, 'core.error.forbidden', {}, 'Forbidden');
  }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm);
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, inputErrorMessage(error), undefined, i18n);
    throw error;
  }
  const name = formData.get('name')?.toString()?.trim() || '';
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';

  if (!name || !mail || !password) {
    return error(400, 'auth.registrationIncomplete', {}, 'Please complete all required fields.');
  }

  if (name.length < 2 || name.length > 32) {
    return error(400, 'auth.usernameLength', {}, 'Username must be between 2 and 32 characters.');
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return error(400, 'auth.passwordTooShort', { count: PASSWORD_MIN_LENGTH }, 'The password must be at least {count} characters.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return error(400, 'auth.emailInvalid', {}, 'The email address is invalid.');
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
      capabilityRuntime: pluginCtx.capabilityRuntime,
    });
    if (filtered?._rejected) {
      return new Response(String(filtered._rejected), { status: 403 });
    }
    if (!filtered || typeof filtered !== 'object') {
      return error(400, 'auth.registrationInvalid', {}, 'The registration details are invalid.');
    }
    registrationData = {
      name: typeof filtered.name === 'string' ? filtered.name.trim() : '',
      mail: typeof filtered.mail === 'string' ? filtered.mail.trim() : '',
      screenName: typeof filtered.screenName === 'string' ? filtered.screenName.trim() : '',
    };
  } catch (caught) {
    console.error({
      event: 'register_filter_failed',
      errorType: caught instanceof Error ? caught.name : 'UnknownError',
    });
    return error(503, 'auth.pluginRegistrationFailed', {}, 'A plugin failed while processing the registration. Please try again later.');
  }

  if (registrationData.name.length < 2 || registrationData.name.length > 32) {
    return error(400, 'auth.usernameLength', {}, 'Username must be between 2 and 32 characters.');
  }
  if (!registrationData.mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registrationData.mail)) {
    return error(400, 'auth.emailInvalid', {}, 'The email address is invalid.');
  }
  if (registrationData.screenName.length > 150) {
    return error(400, 'auth.nicknameTooLong', {}, 'The nickname is too long.');
  }

  const [[existingName], [existingMail]] = await db.batch([
    db.select({ uid: schema.users.uid }).from(schema.users)
      .where(eq(schema.users.name, registrationData.name)).limit(1),
    db.select({ uid: schema.users.uid }).from(schema.users)
      .where(eq(schema.users.mail, registrationData.mail)).limit(1),
  ]);
  if (existingName) {
    return error(409, 'auth.usernameTaken', {}, 'That username is already in use.');
  }
  if (existingMail) {
    return error(409, 'auth.emailTaken', {}, 'That email address is already in use.');
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
    return error(500, 'auth.registrationFailed', {}, 'Registration failed.');
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
  }, { capabilityRuntime: pluginCtx.capabilityRuntime });

  // No auto-login: redirect to the login page with a success flash. This
  // closes the cross-site session-fixation surface where a third-party
  // page could provision an attacker-owned account into the victim's
  // browser without their awareness.
  return new Response(null, {
    status: 302,
    headers: createFlashRedirectHeaders('/admin/login', REGISTER_NOTICE_FLASH_COOKIE, i18nMessage('auth.registrationSuccess', 'Registration successful. Sign in with your new account.'), '/admin/login', request),
  });
};
