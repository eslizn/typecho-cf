/**
 * Plugin management API
 * POST: Activate/deactivate a plugin
 */
import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions, setOption, deleteOption } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission, requireAdminCSRF } from '@/lib/auth';
import { pluginExists, parseActivatedPlugins, setActivatedPlugins, getAvailablePlugins, pluginHasConfig, getPluginConfigDefaults } from '@/lib/plugin';
import { purgeSiteCache } from '@/lib/cache';
import { env } from 'cloudflare:workers';

async function authenticate(request: Request) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);

  if (!token || !options.secret) return null;

  const result = await validateAuthToken(token, options.secret, db);
  if (!result) return null;
  if (!hasPermission(result.user.group || 'visitor', 'administrator')) return null;

  return { db, user: result.user, options };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const csrfError = await requireAdminCSRF(request, auth.options.secret as string, auth.user.authCode!, auth.user.uid);
  if (csrfError) return csrfError;

  try {
    const body = await request.json() as { plugin?: string; action?: string };
    const pluginId = body.plugin;
    const action = body.action; // 'activate' or 'deactivate'

    if (!pluginId || typeof pluginId !== 'string') {
      return new Response(JSON.stringify({ error: '请指定插件标识' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action !== 'activate' && action !== 'deactivate') {
      return new Response(JSON.stringify({ error: '无效的操作，请使用 activate 或 deactivate' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!pluginExists(pluginId)) {
      return new Response(JSON.stringify({ error: `插件 "${pluginId}" 不存在，请先通过 npm 安装` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get current activated list
    const currentIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
    const idSet = new Set(currentIds);

    if (action === 'activate') {
      idSet.add(pluginId);

      // Save default config on activation (like PHP Typecho)
      if (pluginHasConfig(pluginId)) {
        const defaults = getPluginConfigDefaults(pluginId);
        if (Object.keys(defaults).length > 0) {
          const existing = auth.options[`plugin:${pluginId}`];
          if (!existing) {
            await setOption(auth.db, `plugin:${pluginId}`, JSON.stringify(defaults));
          }
        }
      }
    } else {
      idSet.delete(pluginId);

      // Delete plugin config on deactivation
      await deleteOption(auth.db, `plugin:${pluginId}`);
    }

    // Save to DB and update runtime state
    const newIds = Array.from(idSet);
    setActivatedPlugins(newIds);
    await setOption(auth.db, 'activatedPlugins', JSON.stringify(newIds));

    // Plugin changes affect page rendering
    await purgeSiteCache(auth.options.siteUrl || '');

    return new Response(JSON.stringify({
      success: true,
      message: action === 'activate' ? `插件 "${pluginId}" 已启用` : `插件 "${pluginId}" 已禁用`,
      plugin: pluginId,
      action,
      activatedPlugins: newIds,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * GET: List all available plugins and their activation status
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Ensure activated state is loaded
  const activatedIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  const plugins = getAvailablePlugins();

  return new Response(JSON.stringify({
    plugins: plugins.map(p => ({
      id: p.id,
      name: p.manifest.name,
      description: p.manifest.description,
      author: p.manifest.author,
      version: p.manifest.version,
      homepage: p.manifest.homepage,
      isActive: p.isActive,
      packageName: p.packageName,
    })),
    activatedPlugins: activatedIds,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
