/**
 * Theme configuration view + save flow.
 *
 * Mirrors plugin-config.ts but for themes. Unlike plugins, themes have no
 * runtime entry point or hook bus, so there is no `config:beforeSave` filter;
 * the save path is: parse form → allowlist to declared fields → restore secret
 * placeholders → store JSON under "theme:<themeId>" → purge site cache.
 */
import type { AdminActionContext } from '@/lib/admin-auth';
import { setOption, type SiteOptions } from '@/lib/options';
import {
  allowlistConfigSettings,
  isRecord,
  maskConfigDefinitions,
  maskConfigValues,
  parseConfigFormData,
  restoreConfigSecrets,
  type ConfigField,
} from '@/lib/config';
import {
  getTheme,
  getThemeConfigDefaults,
  loadThemeConfig,
  themeHasConfig,
  type ThemeInfo,
} from '@/lib/theme';

export class ThemeConfigurationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid',
    message: string,
    public readonly status: 400 | 404 = code === 'not_found' ? 404 : 400,
  ) {
    super(message);
    this.name = 'ThemeConfigurationError';
  }
}

export interface ThemeConfigurationView {
  theme: string;
  name: string;
  fields: Record<string, ConfigField>;
  values: Record<string, unknown>;
}

export interface ThemeConfigurationSaveInput {
  themeId: string;
  settings: Record<string, unknown> | FormData;
}

export interface ThemeConfigurationSaveResult {
  success: true;
  message: string;
  theme: string;
  settings: Record<string, unknown>;
}

function getThemeDefinition(themeId: string): { theme: ThemeInfo; fields: Record<string, ConfigField> } {
  const theme = getTheme(themeId);
  if (!theme || !themeHasConfig(themeId) || !theme.manifest.config) {
    throw new ThemeConfigurationError('not_found', '主题不存在或无配置项');
  }
  return { theme, fields: theme.manifest.config };
}

export function getThemeConfigurationView(
  options: SiteOptions | Record<string, unknown>,
  themeId: string,
): ThemeConfigurationView {
  const { theme, fields } = getThemeDefinition(themeId);
  const values = loadThemeConfig(options, themeId);
  return {
    theme: themeId,
    name: theme.manifest.name,
    fields: maskConfigDefinitions(fields),
    values: maskConfigValues(fields, values),
  };
}

export async function saveThemeConfiguration(
  auth: AdminActionContext,
  input: ThemeConfigurationSaveInput,
): Promise<ThemeConfigurationSaveResult> {
  const themeId = input.themeId.trim();
  if (!themeId) throw new ThemeConfigurationError('invalid', '请指定主题标识');
  const { fields } = getThemeDefinition(themeId);

  const submitted = input.settings instanceof FormData
    ? parseConfigFormData(fields, input.settings)
    : input.settings;
  if (!isRecord(submitted)) {
    throw new ThemeConfigurationError('invalid', '请提供配置数据');
  }

  const defaults = getThemeConfigDefaults(themeId);
  const previous = loadThemeConfig(auth.options, themeId);
  const sanitized = allowlistConfigSettings(fields, submitted, defaults);
  const finalSettings = restoreConfigSecrets(fields, sanitized, previous);

  await setOption(auth.db, `theme:${themeId}`, JSON.stringify(finalSettings));

  return {
    success: true,
    message: auth.i18n.t('admin.config.themeSaved', {}, 'Theme settings saved'),
    theme: themeId,
    settings: maskConfigValues(fields, finalSettings),
  };
}
