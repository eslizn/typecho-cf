/**
 * Plugin Configuration API
 * GET:  Read plugin config  → /api/admin/plugin-config?id=<pluginId>
 * POST: Save plugin config  → /api/admin/plugin-config  { plugin: id, settings: {...} }
 */
import type { APIRoute } from 'astro';
import { setOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { applyFilter, getPlugin, pluginHasConfig, isPluginActive, loadPluginConfig, getPluginConfigDefaults, type PluginConfigField } from '@/lib/plugin';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { withTimeout } from '@/lib/timeout';

const PLUGIN_CONFIG_TIMEOUT_MS = 5_000;

/**
 * Sentinel sent over the wire in place of password / hidden field values
 * so the admin UI can rebind without ever seeing the real secret in
 * memory or logs (G3-2). On save, fields equal to the sentinel are
 * preserved by merging the previously stored value back in.
 */
const SECRET_PLACEHOLDER = '__PLUGIN_CONFIG_SECRET__';

function isSecretField(field: PluginConfigField | undefined): boolean {
  if (!field) return false;
  return field.type === 'password' || field.type === 'hidden';
}

function maskSecretsForRead(
  configDef: Record<string, PluginConfigField>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = configDef[key];
    if (isSecretField(field)) {
      out[key] = raw && String(raw).length > 0 ? SECRET_PLACEHOLDER : '';
    } else if (field?.type === 'repeatable' && Array.isArray(raw)) {
      const itemFields = field.itemFields || {};
      out[key] = raw.map(row => {
        if (!row || typeof row !== 'object') return row;
        const masked: Record<string, unknown> = {};
        for (const [innerKey, innerVal] of Object.entries(row as Record<string, unknown>)) {
          masked[innerKey] = isSecretField(itemFields[innerKey]) && innerVal && String(innerVal).length > 0
            ? SECRET_PLACEHOLDER
            : innerVal;
        }
        return masked;
      });
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function restoreSecretsForWrite(
  configDef: Record<string, PluginConfigField>,
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const [key, field] of Object.entries(configDef)) {
    if (isSecretField(field) && incoming[key] === SECRET_PLACEHOLDER) {
      out[key] = previous[key];
    } else if (field.type === 'repeatable' && Array.isArray(incoming[key])) {
      const itemFields = field.itemFields || {};
      const previousRows = Array.isArray(previous[key]) ? (previous[key] as unknown[]) : [];
      out[key] = (incoming[key] as unknown[]).map((row, idx) => {
        if (!row || typeof row !== 'object') return row;
        const prevRow = (previousRows[idx] as Record<string, unknown>) || {};
        const merged: Record<string, unknown> = { ...(row as Record<string, unknown>) };
        for (const [innerKey, innerField] of Object.entries(itemFields)) {
          if (isSecretField(innerField) && merged[innerKey] === SECRET_PLACEHOLDER) {
            merged[innerKey] = prevRow[innerKey];
          }
        }
        return merged;
      });
    }
  }
  return out;
}

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
  const masked = maskSecretsForRead(plugin.manifest.config!, config);

  return new Response(JSON.stringify({
    plugin: pluginId,
    name: plugin.manifest.name,
    fields: plugin.manifest.config,
    values: masked,
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
    const previousConfig = loadPluginConfig(auth.options, pluginId);
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

    // Replace any placeholder values with the previously stored secret —
    // the admin UI sends back __PLUGIN_CONFIG_SECRET__ when the field
    // wasn't edited so we never round-trip plaintext for password fields.
    const restored = restoreSecretsForWrite(configDef, sanitized, previousConfig);

    const validation = await withTimeout(
      applyFilter('plugin:config:beforeSave', {
        success: true,
        settings: restored,
      }, {
        pluginId,
        settings: restored,
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

    const finalSettings = validation.settings || restored;
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
