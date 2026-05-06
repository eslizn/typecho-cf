/**
 * Plugin management API
 * POST: Activate/deactivate a plugin
 */
import type { APIRoute } from 'astro';
import { setOption, deleteOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { pluginExists, parseActivatedPlugins, setActivatedPlugins, getAvailablePlugins, pluginHasConfig, getPluginConfigDefaults } from '@/lib/plugin';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: auth.status === 401 ? 401 : 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
    await bumpCacheVersion(auth.db);
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
  const auth = await requireAdminAction(request, 'administrator', { csrf: false });
  if (isAdminActionResponse(auth)) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: auth.status === 401 ? 401 : 403,
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
