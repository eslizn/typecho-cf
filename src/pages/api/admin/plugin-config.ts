import type { APIRoute } from 'astro';
import { isAdminActionResponse, jsonAdminActionError, requireAdminAction } from '@/lib/admin-auth';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData, readBoundedJson } from '@/lib/input';
import { jsonError, jsonOk, textError } from '@/lib/http';
import type { I18n } from '@/lib/i18n';
import { i18nMessage } from '@/lib/i18n';
import {
  getPluginConfigurationView,
  PluginConfigurationError,
  savePluginConfiguration,
} from '@/lib/plugin-config';

function domainError(error: unknown, json: boolean, i18n: I18n): Response {
  if (error instanceof PluginConfigurationError) {
    const message = error.code === 'not_found'
      ? i18nMessage('admin.config.pluginNotFound', 'The plugin does not exist or has no settings.')
      : error.code === 'inactive'
        ? i18nMessage('admin.config.pluginInactive', 'Enable the plugin before editing its settings.')
        : error.code === 'invalid'
          ? i18nMessage('admin.error.invalidRequest', error.message || 'Invalid request.')
          : error.message;
    return json ? jsonError(error.status, message, undefined, i18n) : textError(error.status, message, undefined, i18n);
  }
  if (error instanceof InputError) {
    const message = inputErrorMessage(error);
    return json ? jsonError(error.status, message, undefined, i18n) : textError(error.status, message, undefined, i18n);
  }
  const message = i18nMessage('admin.config.pluginSaveFailed', 'Plugin settings could not be saved.');
  return json ? jsonError(400, message, undefined, i18n) : textError(400, message, undefined, i18n);
}

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await requireAdminAction(request, 'administrator', { csrf: false });
  if (isAdminActionResponse(auth)) {
    return jsonAdminActionError(request, auth);
  }
  try {
    return jsonOk(getPluginConfigurationView(auth.options, url.searchParams.get('id') || ''));
  } catch (error) {
    return domainError(error, true, auth.i18n);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return jsonAdminActionError(request, auth);
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  const isJson = contentType.startsWith('application/json');
  try {
    let pluginId = '';
    let settings: Record<string, unknown> | FormData;
    if (isJson) {
      const body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new InputError(400, 'Malformed JSON body');
      }
      const record = body as Record<string, unknown>;
      pluginId = typeof record.plugin === 'string' ? record.plugin : '';
      if (!record.settings || typeof record.settings !== 'object' || Array.isArray(record.settings)) {
        throw new PluginConfigurationError('invalid', 'Configuration data is required.');
      }
      settings = record.settings as Record<string, unknown>;
    } else {
      const formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.adminForm);
      pluginId = String(formData.get('plugin') ?? '');
      settings = formData;
    }

    const result = await savePluginConfiguration(auth, { pluginId, settings, request });
    if (isJson) return jsonOk(result);
    return new Response(null, {
      status: 303,
      headers: { Location: `/admin/plugin-config?id=${encodeURIComponent(result.plugin)}&saved=1` },
    });
  } catch (error) {
    return domainError(error, isJson, auth.i18n);
  }
};
