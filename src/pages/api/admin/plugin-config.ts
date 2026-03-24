/**
 * Plugin Configuration API
 * GET:  Read plugin config  → /api/admin/plugin-config?id=<pluginId>
 * POST: Save plugin config  → /api/admin/plugin-config  { plugin: id, settings: {...} }
 */
import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions, setOption } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { getPlugin, pluginHasConfig, isPluginActive, loadPluginConfig, getPluginConfigDefaults } from '@/lib/plugin';
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

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pluginId = url.searchParams.get('id') || '';
  const plugin = getPlugin(pluginId);

  if (!plugin || !pluginHasConfig(pluginId)) {
    return new Response(JSON.stringify({ error: '插件不存在或无配置项' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const config = loadPluginConfig(auth.options, pluginId);

  return new Response(JSON.stringify({
    plugin: pluginId,
    name: plugin.manifest.name,
    fields: plugin.manifest.config,
    values: config,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as { plugin?: string; settings?: Record<string, any> };
    const pluginId = body.plugin;
    const settings = body.settings;

    if (!pluginId || typeof pluginId !== 'string') {
      return new Response(JSON.stringify({ error: '请指定插件标识' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const plugin = getPlugin(pluginId);
    if (!plugin || !pluginHasConfig(pluginId)) {
      return new Response(JSON.stringify({ error: '插件不存在或无配置项' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!isPluginActive(pluginId)) {
      return new Response(JSON.stringify({ error: '请先启用插件' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!settings || typeof settings !== 'object') {
      return new Response(JSON.stringify({ error: '请提供配置数据' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only keep keys that are defined in the plugin's config
    const configDef = plugin.manifest.config!;
    const sanitized: Record<string, any> = {};
    for (const key of Object.keys(configDef)) {
      if (key in settings) {
        sanitized[key] = settings[key];
      } else {
        // Use default
        const defaults = getPluginConfigDefaults(pluginId);
        sanitized[key] = defaults[key];
      }
    }

    await setOption(auth.db, `plugin:${pluginId}`, JSON.stringify(sanitized));

    return new Response(JSON.stringify({
      success: true,
      message: '插件设置已经保存',
      plugin: pluginId,
      settings: sanitized,
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
