/**
 * Plugin Configuration API
 * GET:  Read plugin config  → /api/admin/plugin-config?id=<pluginId>
 * POST: Save plugin config  → /api/admin/plugin-config  { plugin: id, settings: {...} }
 */
import type { APIRoute } from 'astro';
import { setOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { applyFilter, getPlugin, pluginHasConfig, isPluginActive, loadPluginConfig, getPluginConfigDefaults } from '@/lib/plugin';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { withTimeout } from '@/lib/timeout';

const PLUGIN_CONFIG_TIMEOUT_MS = 5_000;

export const GET: APIRoute = async ({ request, url }) => {
  const auth = await requireAdminAction(request, 'administrator', { csrf: false });
  if (isAdminActionResponse(auth)) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: auth.status === 401 ? 401 : 403,
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
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: auth.status === 401 ? 401 : 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { plugin?: string; settings?: Record<string, unknown> };
  try {
    body = await request.json() as { plugin?: string; settings?: Record<string, unknown> };
  } catch {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
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
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(configDef)) {
      if (key in settings) {
        sanitized[key] = settings[key];
      } else {
        // Use default
        const defaults = getPluginConfigDefaults(pluginId);
        sanitized[key] = defaults[key];
      }
    }

    const validation = await withTimeout(
      applyFilter('plugin:config:beforeSave', {
        success: true,
        settings: sanitized,
      }, {
        pluginId,
        settings: sanitized,
        db: auth.db,
        options: auth.options,
        user: auth.user,
        request,
      }),
      PLUGIN_CONFIG_TIMEOUT_MS,
      '插件配置校验超时，请稍后重试',
    );

    if (!validation?.success) {
      return new Response(JSON.stringify({ error: validation?.error || '插件配置校验失败' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const finalSettings = validation.settings || sanitized;
    await setOption(auth.db, `plugin:${pluginId}`, JSON.stringify(finalSettings));

    // Purge cached options so subsequent requests read the updated config
    await bumpCacheVersion(auth.db);
    await purgeSiteCache(auth.options.siteUrl || '');

    return new Response(JSON.stringify({
      success: true,
      message: '插件设置已经保存',
      plugin: pluginId,
      settings: finalSettings,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : '插件配置保存失败' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
