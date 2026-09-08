import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { applyFilter, parseActivatedPlugins } from '@/lib/plugin';
import { hasPermission } from '@/lib/auth';
import { withTimeout } from '@/lib/timeout';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { readBoundedJson } from '@/lib/input';

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
    return new Response(JSON.stringify({ error: auth.status === 401 ? 'Unauthorized' : 'Forbidden' }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { plugin?: string; action?: string; payload?: unknown };
  try {
    body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as typeof body;
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const pluginId = body.plugin || '';
  const action = body.action || '';
  if (!/^[a-z0-9-]+$/.test(pluginId) || !action) {
    return json({ error: '缺少插件或操作参数' }, 400);
  }

  const pluginCtx = auth.pluginCtx;
  const activatedIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
  if (!activatedIds.includes(pluginId)) {
    return json({ error: '插件未启用' }, 403);
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
    });
    if (typeof declared === 'string' && declared) requiredGroup = declared;
  } catch {
    // Filter threw → keep the safe default.
  }
  if (!hasPermission(auth.user.group || 'visitor', requiredGroup)) {
    return json({ error: 'Forbidden' }, 403);
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
      }),
      PLUGIN_ACTION_TIMEOUT_MS,
      '插件操作超时，请稍后重试',
    );

    if (!result?.handled) {
      return json({ error: '插件未处理该操作' }, 404);
    }
    if (result.response instanceof Response) {
      return result.response;
    }

    return json(result, result.success === false ? 400 : 200);
  } catch (error) {
    return json({
      success: false,
      error: error instanceof Error ? error.message : '插件操作失败',
    }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
