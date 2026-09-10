/**
 * Plugin management API
 * POST: Activate/deactivate a plugin
 */
import type { APIRoute } from 'astro';
import { setOption, deleteOption } from '@/lib/options';
import { isAdminActionResponse, jsonAdminActionError, requireAdminAction } from '@/lib/admin-auth';
import { pluginExists, parseActivatedPlugins, setActivatedPlugins, getAvailablePlugins, pluginHasConfig, getPluginConfigDefaults } from '@/lib/plugin';
import { jsonError, jsonOk } from '@/lib/http';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { readBoundedJson } from '@/lib/input';
import { i18nMessage } from '@/lib/i18n';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return jsonAdminActionError(request, auth);
  }

  try {
    const body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as { plugin?: string; action?: string };
    const pluginId = body.plugin;
    const action = body.action; // 'activate' or 'deactivate'

    if (!pluginId || typeof pluginId !== 'string') {
      return jsonError(400, i18nMessage('admin.api.pluginRequired', 'Please specify a plugin.'), undefined, auth.i18n);
    }

    if (action !== 'activate' && action !== 'deactivate') {
      return jsonError(400, i18nMessage('admin.api.pluginActionInvalid', 'Invalid action. Use activate or deactivate.'), undefined, auth.i18n);
    }

    if (!pluginExists(pluginId)) {
      return jsonError(404, i18nMessage('admin.api.pluginNotFound', 'Plugin "{id}" does not exist. Install it with npm first.', { id: pluginId }), undefined, auth.i18n);
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
    await setActivatedPlugins(auth.pluginCtx, newIds);
    await setOption(auth.db, 'activatedPlugins', JSON.stringify(newIds));

    // setOption() advanced cacheVersion above: public pages and other PoPs
    // pick up the new plugin set on their next request.

    return jsonOk({
      success: true,
      message: action === 'activate'
        ? auth.i18n.t('admin.plugin.activated', { id: pluginId }, 'Plugin "{id}" enabled')
        : auth.i18n.t('admin.plugin.deactivated', { id: pluginId }, 'Plugin "{id}" disabled'),
      plugin: pluginId,
      action,
      activatedPlugins: newIds,
    });
  } catch (err) {
    return jsonError(400, i18nMessage('admin.error.invalidRequest', 'Invalid request.'), undefined, auth.i18n);
  }
};

/**
 * GET: List all available plugins and their activation status
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator', { csrf: false, plugins: true });
  if (isAdminActionResponse(auth)) {
    return jsonAdminActionError(request, auth);
  }

  const activatedIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
  const plugins = getAvailablePlugins(auth.pluginCtx);

  return jsonOk({
    plugins: plugins.map(p => ({
      id: p.id,
      name: p.isActive ? auth.i18n.t(`plugin.${p.id}.name`, {}, p.manifest.name) : p.manifest.name,
      description: p.isActive
        ? auth.i18n.t(`plugin.${p.id}.description`, {}, p.manifest.description || '')
        : p.manifest.description,
      author: p.manifest.author,
      version: p.manifest.version,
      homepage: p.manifest.homepage,
      isActive: p.isActive,
      packageName: p.packageName,
    })),
    activatedPlugins: activatedIds,
  });
};
