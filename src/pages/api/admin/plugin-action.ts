import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { applyFilter, parseActivatedPlugins, setActivatedPlugins } from '@/lib/plugin';
import { withTimeout } from '@/lib/timeout';

const PLUGIN_ACTION_TIMEOUT_MS = 15_000;

export const POST: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) {
    return new Response(JSON.stringify({ error: auth.status === 401 ? 'Unauthorized' : 'Forbidden' }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { plugin?: string; action?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const pluginId = body.plugin || '';
  const action = body.action || '';
  if (!/^[a-z0-9-]+$/.test(pluginId) || !action) {
    return json({ error: '缺少插件或操作参数' }, 400);
  }

  const activatedIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);
  if (!activatedIds.includes(pluginId)) {
    return json({ error: '插件未启用' }, 403);
  }

  try {
    const result = await withTimeout(
      applyFilter(`plugin:${pluginId}:action`, { handled: false }, {
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
