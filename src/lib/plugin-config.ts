import type { AdminActionContext } from '@/lib/admin-auth';
import { PLUGIN_CONFIG_TIMEOUT_MS } from '@/lib/constants';
import { setOption, type SiteOptions } from '@/lib/options';
import {
  applyFilter,
  getPlugin,
  getPluginConfigDefaults,
  isPluginActive,
  loadPluginConfig,
  parsePluginConfigFormData,
  pluginHasConfig,
  PLUGIN_CONFIG_ROW_ID,
  type PluginConfigField,
} from '@/lib/plugin';
import { withTimeout } from '@/lib/timeout';
import {
  allowlistConfigSettings as allowlistSettings,
  findTokenLimitOverflow,
  isRecord,
  maskConfigDefinition as maskFieldDefinition,
  maskConfigDefinitions as maskedDefinitions,
  maskConfigValue as maskValue,
  maskConfigValues as maskValues,
  restoreConfigSecrets as restoreSecrets,
  restoreConfigValue as restoreValue,
  sanitizeConfigValue as sanitizeValue,
  stripConfigRowIds,
} from '@/lib/config';

export { CONFIG_SECRET_PLACEHOLDER as PLUGIN_CONFIG_SECRET_PLACEHOLDER } from '@/lib/config';
export { PLUGIN_CONFIG_ROW_ID };

export class PluginConfigurationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'inactive' | 'invalid' | 'validation_failed',
    message: string,
    public readonly status: 400 | 404 = code === 'not_found' ? 404 : 400,
  ) {
    super(message);
    this.name = 'PluginConfigurationError';
  }
}

export interface PluginConfigurationView {
  plugin: string;
  name: string;
  fields: Record<string, PluginConfigField>;
  values: Record<string, unknown>;
}

export interface PluginConfigurationSaveInput {
  pluginId: string;
  settings: Record<string, unknown> | FormData;
  request: Request;
}

export interface PluginConfigurationSaveResult {
  success: true;
  message: string;
  plugin: string;
  settings: Record<string, unknown>;
}

function assertTokenLimits(
  fields: Record<string, PluginConfigField>,
  submitted: Record<string, unknown>,
  auth: AdminActionContext,
): void {
  const overflow = findTokenLimitOverflow(fields, submitted);
  if (!overflow) return;
  // `validation_failed` is the code whose message the API surfaces to the
  // admin; `invalid` is replaced by a generic notice.
  throw new PluginConfigurationError('validation_failed', auth.i18n.t(
    'admin.config.tokenLimitReached',
    { max: overflow.max },
    `At most ${overflow.max} tokens are allowed.`,
  ));
}

function getDefinition(pluginId: string) {
  const plugin = getPlugin(pluginId);
  if (!plugin || !pluginHasConfig(pluginId) || !plugin.manifest.config) {
    throw new PluginConfigurationError('not_found', '插件不存在或无配置项');
  }
  return { plugin, fields: plugin.manifest.config };
}

export function getPluginConfigurationView(
  options: SiteOptions | Record<string, unknown>,
  pluginId: string,
): PluginConfigurationView {
  const { plugin, fields } = getDefinition(pluginId);
  const values = loadPluginConfig(options, pluginId);
  return {
    plugin: pluginId,
    name: plugin.manifest.name,
    fields: maskedDefinitions(fields),
    values: maskValues(fields, values),
  };
}

export async function savePluginConfiguration(
  auth: AdminActionContext,
  input: PluginConfigurationSaveInput,
): Promise<PluginConfigurationSaveResult> {
  const pluginId = input.pluginId.trim();
  if (!pluginId) throw new PluginConfigurationError('invalid', '请指定插件标识');
  const { fields } = getDefinition(pluginId);
  if (!isPluginActive(auth.pluginCtx, pluginId)) {
    throw new PluginConfigurationError('inactive', '请先启用插件');
  }

  const submitted = input.settings instanceof FormData
    ? parsePluginConfigFormData(fields, input.settings)
    : input.settings;
  if (!isRecord(submitted)) {
    throw new PluginConfigurationError('invalid', '请提供配置数据');
  }
  assertTokenLimits(fields, submitted, auth);

  const defaults = getPluginConfigDefaults(pluginId);
  const previous = loadPluginConfig(auth.options, pluginId);
  const sanitized = allowlistSettings(fields, submitted, defaults);
  const restored = restoreSecrets(fields, sanitized, previous);

  let validation: { success?: boolean; settings?: Record<string, unknown>; error?: string };
  const validationFallback = auth.i18n.t(
    'admin.config.validationFailed',
    {},
    'Plugin configuration validation failed.',
  );
  try {
    validation = await withTimeout(
      applyFilter(auth.pluginCtx, 'plugin:config:beforeSave', {
        success: true,
        settings: restored,
      }, {
        pluginId,
        settings: restored,
        db: auth.db,
        options: auth.options,
        user: auth.user,
        request: input.request,
        i18n: auth.i18n,
        capabilityRuntime: auth.pluginCtx.capabilityRuntime,
      }),
      PLUGIN_CONFIG_TIMEOUT_MS,
      auth.i18n.t(
        'admin.config.validationTimeout',
        {},
        'Plugin configuration validation timed out. Try again later.',
      ),
    );
  } catch (error) {
    throw new PluginConfigurationError(
      'validation_failed',
      error instanceof Error ? error.message : validationFallback,
    );
  }

  if (!validation?.success) {
    throw new PluginConfigurationError(
      'validation_failed',
      validation?.error || validationFallback,
    );
  }

  const validatedInput = isRecord(validation.settings) ? validation.settings : restored;
  const finalAllowed = allowlistSettings(fields, validatedInput, restored);
  const finalSettings = stripConfigRowIds(fields, restoreSecrets(fields, finalAllowed, previous)) as Record<string, unknown>;
  await setOption(auth.db, `plugin:${pluginId}`, JSON.stringify(finalSettings));

  return {
    success: true,
    message: auth.i18n.t('admin.config.pluginSaved', {}, 'Plugin settings saved'),
    plugin: pluginId,
    settings: maskValues(fields, finalSettings),
  };
}
