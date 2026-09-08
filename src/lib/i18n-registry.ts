import { coreCatalogs } from '@/i18n/catalogs';
import {
  normalizeLocale,
  type TranslationCatalog,
} from '@/lib/i18n';

export interface PluginTranslationRegistration {
  pluginId: string;
  locale: string;
  messages: TranslationCatalog;
  displayName?: string;
}

export interface AvailableTranslationLocale {
  locale: string;
  displayName?: string;
}

const MAX_TRANSLATION_KEY_LENGTH = 200;
const MAX_TRANSLATION_VALUE_LENGTH = 50_000;
const MAX_TRANSLATION_ENTRIES = 10_000;

const committedTranslations = new Map<string, PluginTranslationRegistration[]>();
const stagedTranslations = new Map<string, PluginTranslationRegistration[]>();
const versionCache = new Map<string, string>();

export function beginPluginTranslationStage(pluginId: string): void {
  stagedTranslations.set(pluginId, []);
}

export function stagePluginTranslation(
  pluginId: string,
  locale: string,
  messages: Record<string, string>,
  displayName?: string,
): void {
  const stage = stagedTranslations.get(pluginId);
  if (!stage) throw new Error(`translation registration outside plugin init: ${pluginId}`);
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale) throw new Error(`invalid translation locale: ${locale}`);

  stage.push({
    pluginId,
    locale: normalizedLocale,
    messages: validateMessages(messages),
    displayName: typeof displayName === 'string' ? displayName.slice(0, MAX_TRANSLATION_VALUE_LENGTH) : undefined,
  });
}

export function commitPluginTranslationStage(pluginId: string): void {
  const stage = stagedTranslations.get(pluginId);
  if (!stage) return;
  committedTranslations.set(pluginId, stage.slice());
  stagedTranslations.delete(pluginId);
  versionCache.clear();
}

export function discardPluginTranslationStage(pluginId: string): void {
  stagedTranslations.delete(pluginId);
}

/**
 * Build a fresh global catalog snapshot. Core catalogs are copied before
 * active plugin registrations are applied, so no request can mutate the
 * shared core maps or observe a disabled plugin's translations.
 */
export function getGlobalTranslationCatalogs(activePluginIds: Iterable<string>): Map<string, TranslationCatalog> {
  const catalogs = new Map<string, TranslationCatalog>();
  for (const [locale, messages] of coreCatalogs) {
    catalogs.set(locale, { ...messages });
  }

  for (const pluginId of uniqueIds(activePluginIds)) {
    for (const registration of committedTranslations.get(pluginId) || []) {
      const current = catalogs.get(registration.locale) || {};
      catalogs.set(registration.locale, { ...current, ...registration.messages });
    }
  }
  return catalogs;
}

/** Return the locale choices made available by core plus active plugins. */
export function getAvailableTranslationLocales(activePluginIds: Iterable<string>): AvailableTranslationLocale[] {
  const locales = new Map<string, AvailableTranslationLocale>();
  for (const locale of coreCatalogs.keys()) locales.set(locale, { locale });

  for (const pluginId of uniqueIds(activePluginIds)) {
    for (const registration of committedTranslations.get(pluginId) || []) {
      const current = locales.get(registration.locale);
      if (current) {
        if (registration.displayName !== undefined) current.displayName = registration.displayName;
      } else {
        locales.set(registration.locale, {
          locale: registration.locale,
          ...(registration.displayName === undefined ? {} : { displayName: registration.displayName }),
        });
      }
    }
  }
  return [...locales.values()];
}

/** Stable content fingerprint used as the translation portion of cache keys. */
export function getTranslationCatalogVersion(activePluginIds: Iterable<string>): string {
  const ids = uniqueIds(activePluginIds);
  const cacheKey = ids.join('\0');
  const cached = versionCache.get(cacheKey);
  if (cached) return cached;

  const parts: string[] = [];
  for (const [locale, messages] of coreCatalogs) {
    parts.push(locale, stableMessages(messages));
  }
  for (const pluginId of ids) {
    parts.push(pluginId);
    for (const registration of committedTranslations.get(pluginId) || []) {
      parts.push(registration.locale, registration.displayName || '', stableMessages(registration.messages));
    }
  }

  const version = `catalog-${fnv1a(parts.join('\0'))}`;
  versionCache.set(cacheKey, version);
  return version;
}

/** Test-only reset; production code never needs to clear catalog state. */
export function resetPluginTranslationRegistry(): void {
  committedTranslations.clear();
  stagedTranslations.clear();
  versionCache.clear();
}

function validateMessages(messages: Record<string, string>): TranslationCatalog {
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
    throw new Error('translation messages must be an object');
  }
  const entries = Object.entries(messages);
  if (entries.length > MAX_TRANSLATION_ENTRIES) throw new Error('translation catalog is too large');

  const validated: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_TRANSLATION_KEY_LENGTH) throw new Error('invalid translation key');
    if (typeof value !== 'string' || value.length > MAX_TRANSLATION_VALUE_LENGTH) {
      throw new Error(`invalid translation value for ${key}`);
    }
    validated[key] = value;
  }
  return validated;
}

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter(id => typeof id === 'string' && id.length > 0))];
}

function stableMessages(messages: TranslationCatalog): string {
  return Object.keys(messages)
    .sort()
    .map(key => `${key}=${messages[key]}`)
    .join('\n');
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
