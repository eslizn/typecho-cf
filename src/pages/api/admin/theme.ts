/**
 * Theme management API
 * POST: Activate a theme
 */
import type { APIRoute } from 'astro';
import { setOption } from '@/lib/options';
import { isAdminActionResponse, jsonAdminActionError, requireAdminAction } from '@/lib/admin-auth';
import { themeExists } from '@/lib/theme';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { readBoundedJson } from '@/lib/input';
import { i18nMessage } from '@/lib/i18n';
import { jsonError, jsonOk } from '@/lib/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return jsonAdminActionError(request, auth);
  }

  try {
    const body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as { theme?: string };
    const themeId = body.theme;

    if (!themeId || typeof themeId !== 'string') {
      return jsonError(400, i18nMessage('admin.api.themeRequired', 'Please specify a theme.'), undefined, auth.i18n);
    }

    // Verify the theme exists
    if (!themeExists(themeId)) {
      return jsonError(404, i18nMessage('admin.api.themeNotFound', 'Theme "{id}" does not exist. Install it with npm first.', { id: themeId }), undefined, auth.i18n);
    }

    // Save to options
    await setOption(auth.db, 'theme', themeId);

    // Theme change affects all pages
    await bumpCacheVersion(auth.db);
    await purgeSiteCache(auth.options.siteUrl || '');

    return jsonOk({
      success: true, 
      message: auth.i18n.t('admin.theme.activated', { id: themeId }, 'Theme switched to "{id}"'),
      theme: themeId,
    });
  } catch (err) {
    return jsonError(400, i18nMessage('admin.error.invalidRequest', 'Invalid request.'), undefined, auth.i18n);
  }
};
