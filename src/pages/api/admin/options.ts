import type { APIRoute } from 'astro';
import { setOptionsBatch } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { parseSiteOptionsInput, SiteOptionsInputError } from '@/lib/options-input';
import { textError } from '@/lib/http';
import { i18nMessage, matchSupportedLocale } from '@/lib/i18n';
import { getAvailableTranslationLocales } from '@/lib/i18n-registry';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/options-general',
  );

  const refererPath = referer.split('?')[0];
  let entries: Record<string, string>;
  try {
    const formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.adminForm);
    entries = parseSiteOptionsInput({ formData, sourcePath: refererPath });
  } catch (error) {
    if (error instanceof InputError) {
      return textError(error.status, inputErrorMessage(error), undefined, auth.i18n);
    }
    if (error instanceof SiteOptionsInputError) {
      return textError(400, i18nMessage('admin.error.invalidRequest', 'Invalid request.'), undefined, auth.i18n);
    }
    throw error;
  }

  if (
    entries.lang !== undefined &&
    entries.lang !== '' &&
    matchSupportedLocale(
      entries.lang,
      getAvailableTranslationLocales(auth.pluginCtx.activatedPlugins).map(({ locale }) => locale),
    ) === null
  ) {
    return textError(400, i18nMessage('admin.error.invalidRequest', 'Invalid request.'), undefined, auth.i18n);
  }

  await setOptionsBatch(auth.db, entries);

  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
