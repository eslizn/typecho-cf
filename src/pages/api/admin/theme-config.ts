import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, readBoundedFormData, readBoundedJson } from '@/lib/input';
import { jsonError, jsonOk } from '@/lib/http';
import type { I18n } from '@/lib/i18n';
import {
  getThemeConfigurationView,
  saveThemeConfiguration,
  ThemeConfigurationError,
} from '@/lib/theme-config';

function domainError(error: unknown, json: boolean, i18n: I18n): Response {
  if (error instanceof ThemeConfigurationError) {
    return json ? jsonError(error.status, error.message, undefined, i18n) : new Response(error.message, { status: error.status });
  }
  if (error instanceof InputError) {
    return json ? jsonError(error.status, error.message, undefined, i18n) : new Response(error.message, { status: error.status });
  }
  return json ? jsonError(400, '主题配置保存失败', undefined, i18n) : new Response('主题配置保存失败', { status: 400 });
}

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await requireAdminAction(request, 'administrator', { csrf: false });
  if (isAdminActionResponse(auth)) {
    return jsonError(auth.status === 401 ? 401 : 403, '权限不足');
  }
  try {
    return jsonOk(getThemeConfigurationView(auth.options, url.searchParams.get('id') || ''));
  } catch (error) {
    return domainError(error, true, auth.i18n);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return jsonError(auth.status === 401 ? 401 : 403, '权限不足');
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  const isJson = contentType.startsWith('application/json');
  try {
    let themeId = '';
    let settings: Record<string, unknown> | FormData;
    if (isJson) {
      const body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new InputError(400, 'Malformed JSON body');
      }
      const record = body as Record<string, unknown>;
      themeId = typeof record.theme === 'string' ? record.theme : '';
      if (!record.settings || typeof record.settings !== 'object' || Array.isArray(record.settings)) {
        throw new ThemeConfigurationError('invalid', '请提供配置数据');
      }
      settings = record.settings as Record<string, unknown>;
    } else {
      const formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.adminForm);
      themeId = String(formData.get('theme') ?? '');
      settings = formData;
    }

    const result = await saveThemeConfiguration(auth, { themeId, settings });
    if (isJson) return jsonOk(result);
    return new Response(null, {
      status: 303,
      headers: { Location: `/admin/theme-config?id=${encodeURIComponent(result.theme)}&saved=1` },
    });
  } catch (error) {
    return domainError(error, isJson, auth.i18n);
  }
};
