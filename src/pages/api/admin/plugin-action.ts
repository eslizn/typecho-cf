import type { APIRoute } from 'astro';
import { isAdminActionResponse, jsonAdminActionError, requireAdminAction } from '@/lib/admin-auth';
import { applyFilter } from '@/lib/plugin';
import { hasPermission } from '@/lib/auth';
import { withTimeout } from '@/lib/timeout';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { readBoundedJson } from '@/lib/input';
import { i18nMessage } from '@/lib/i18n';
import { jsonError } from '@/lib/http';

const PLUGIN_ACTION_TIMEOUT_MS = 60_000;

/**
 * Minimum group required to call this endpoint at all. We still call the
 * plugin's own auth filter below to pick the *action*-specific role — but the
 * outer gate keeps unauthenticated / visitor callers out even if a plugin
 * forgets to declare a role.
 */
const BASE_REQUIRED_GROUP = 'contributor';

/**
 * Default role required to invoke a plugin action when the plugin has not
 * declared one via the `plugin:<id>:action:authorize` filter. Kept at
 * administrator so a plugin that ships a new action without updating its
 * auth filter fails closed rather than open.
 */
const DEFAULT_ACTION_ROLE = 'administrator';

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, BASE_REQUIRED_GROUP);
  if (isAdminActionResponse(auth)) {
    return jsonAdminActionError(request, auth);
  }

  let body: { plugin?: string; action?: string; payload?: unknown };
  try {
    body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as typeof body;
  } catch {
    return jsonError(400, i18nMessage('admin.plugin.actionRequestInvalid', 'Invalid request.'), undefined, auth.i18n);
  }

  const pluginId = body.plugin || '';
  const action = body.action || '';
  if (!/^[a-z0-9-]+$/.test(pluginId) || !action) {
    return jsonError(400, i18nMessage('admin.plugin.actionParamsRequired', 'A plugin and action are required.'), undefined, auth.i18n);
  }

  const pluginCtx = auth.pluginCtx;
  if (!auth.pluginCtx.activatedPlugins.has(pluginId)) {
    return jsonError(403, i18nMessage('admin.plugin.inactive', 'The plugin is not enabled.'), undefined, auth.i18n);
  }

  // Ask the plugin what role it wants for this action. Plugins can inspect
  // action + payload and return a group name; anything else (or no handler)
  // means "unspecified" → treated as administrator so a plugin that hasn't
  // opted in fails closed. Handlers return the plain group string.
  let requiredGroup = DEFAULT_ACTION_ROLE;
  try {
  const declared = await applyFilter(pluginCtx, `plugin:${pluginId}:action:authorize`, DEFAULT_ACTION_ROLE, {
      action,
      payload: body.payload || {},
      user: auth.user,
      i18n: auth.i18n,
      capabilityRuntime: auth.pluginCtx.capabilityRuntime,
    });
    if (typeof declared === 'string' && declared) requiredGroup = declared;
  } catch {
    // Filter threw → keep the safe default.
  }
  if (!hasPermission(auth.user.group || 'visitor', requiredGroup)) {
    return jsonError(403, i18nMessage('admin.plugin.actionForbidden', 'Forbidden'), undefined, auth.i18n);
  }

  try {
    const result = await withTimeout(
      applyFilter(pluginCtx, `plugin:${pluginId}:action`, { handled: false }, {
        action,
        payload: body.payload || {},
        db: auth.db,
        options: auth.options,
        user: auth.user,
        request,
        i18n: auth.i18n,
        capabilityRuntime: auth.pluginCtx.capabilityRuntime,
      }),
      PLUGIN_ACTION_TIMEOUT_MS,
      auth.i18n.t('admin.plugin.actionTimeout', {}, 'The plugin action timed out. Try again later.'),
    );

    if (!result?.handled) {
      return jsonError(404, i18nMessage('admin.plugin.actionUnhandled', 'The plugin did not handle this action.'), undefined, auth.i18n);
    }
    if (result.response instanceof Response) {
      return result.response;
    }

    return json(result, result.success === false ? 400 : 200);
  } catch (error) {
    return json({
      success: false,
      error: error instanceof Error
        ? error.message
        : auth.i18n.t('admin.plugin.actionFailed', {}, 'The plugin action failed.'),
    }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
