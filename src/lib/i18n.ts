/**
 * Locale resolution and server-side message formatting.
 *
 * This module deliberately has no Astro, database, plugin, or theme
 * dependency.  Keeping the resolver and formatter pure makes the request
 * boundary easy to test and prevents request-specific locale state from
 * leaking into a Worker isolate.
 */

export const DEFAULT_LOCALE = 'en';
export const MAX_ACCEPT_LANGUAGE_LENGTH = 4096;
export const MAX_ACCEPT_LANGUAGE_RANGES = 20;
export const MAX_LOCALE_LENGTH = 128;
export const MAX_MESSAGE_KEY_LENGTH = 200;
export const MAX_MESSAGE_VARIABLES = 20;
export const MAX_MESSAGE_VALUE_LENGTH = 2000;
export const MAX_MESSAGE_FALLBACK_LENGTH = 5000;
export const MAX_TRANSLATION_KEY_LENGTH = 200;
export const MAX_TRANSLATION_VALUE_LENGTH = 50_000;
export const MAX_TRANSLATION_ENTRIES = 10_000;

export type MessageVariable = string | number;
export type MessageVariables = Record<string, MessageVariable>;
export type TranslationCatalog = Readonly<Record<string, string>>;
export type TranslationCatalogs =
  | ReadonlyMap<string, TranslationCatalog>
  | Readonly<Record<string, TranslationCatalog>>;

export interface I18nMessage {
  key: string;
  variables?: MessageVariables;
  fallbackText?: string;
}

export interface I18n {
  readonly locale: string;
  t(key: string, variables?: MessageVariables, fallbackText?: string): string;
  tPlural(
    key: string,
    count: number,
    variables?: MessageVariables,
    fallbackText?: string,
  ): string;
}

export interface AcceptLanguageRange {
  range: string;
  q: number;
  order: number;
}

export interface ResolvedLocale {
  locale: string;
  bundleName: string;
  source: 'fixed' | 'accept-language' | 'fallback';
}

export interface CreateI18nOptions {
  locale: string;
  catalogs: TranslationCatalogs;
  /** Optional theme-local catalogs. They are checked before global catalogs. */
  scopedCatalogs?: TranslationCatalogs;
}

export function i18nMessage(
  key: string,
  fallbackText?: string,
  variables?: MessageVariables,
): I18nMessage {
  return {
    key,
    ...(variables ? { variables } : {}),
    ...(fallbackText !== undefined ? { fallbackText } : {}),
  };
}

/** Validate a message descriptor before it crosses a cookie/API boundary. */
export function isI18nMessage(value: unknown): value is I18nMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.key !== 'string' ||
    candidate.key.length === 0 ||
    candidate.key.length > MAX_MESSAGE_KEY_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(candidate.key)
  ) return false;

  if (candidate.fallbackText !== undefined && (
    typeof candidate.fallbackText !== 'string' ||
    candidate.fallbackText.length > MAX_MESSAGE_FALLBACK_LENGTH
  )) return false;

  if (candidate.variables === undefined) return true;
  if (!candidate.variables || typeof candidate.variables !== 'object' || Array.isArray(candidate.variables)) return false;
  const variables = candidate.variables as Record<string, unknown>;
  const entries = Object.entries(variables);
  if (entries.length > MAX_MESSAGE_VARIABLES) return false;
  return entries.every(([name, variable]) => (
    /^[A-Za-z0-9_.-]{1,64}$/.test(name) &&
    ((typeof variable === 'string' && variable.length <= MAX_MESSAGE_VALUE_LENGTH) ||
      (typeof variable === 'number' && Number.isFinite(variable)))
  ));
}

/** Copy a descriptor into a bounded plain object, dropping unknown fields. */
export function normalizeI18nMessage(value: unknown): I18nMessage | null {
  if (!isI18nMessage(value)) return null;
  const candidate = value as I18nMessage;
  return {
    key: candidate.key,
    ...(candidate.variables ? { variables: { ...candidate.variables } } : {}),
    ...(candidate.fallbackText !== undefined ? { fallbackText: candidate.fallbackText } : {}),
  };
}

/** Resolve a descriptor at the final presentation boundary. */
export function resolveI18nMessage(message: string | I18nMessage, i18n?: I18n): string {
  if (typeof message === 'string') return message;
  const normalized = normalizeI18nMessage(message);
  if (!normalized) return '';
  return i18n
    ? i18n.t(normalized.key, normalized.variables, normalized.fallbackText)
    : interpolateMessage(normalized.fallbackText ?? normalized.key, normalized.variables);
}

/**
 * Normalize both the legacy Typecho underscore form and BCP-47 locale tags.
 * Empty string is intentionally preserved as the auto-selection sentinel.
 */
export function normalizeLocale(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return '';
  if (value.length > MAX_LOCALE_LENGTH) return null;
  if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(value)) return null;

  try {
    return Intl.getCanonicalLocales(value.replace(/_/g, '-'))[0] || null;
  } catch {
    return null;
  }
}

/** Parse a bounded Accept-Language header into q-sorted ranges. */
export function parseAcceptLanguage(header: string | null | undefined): AcceptLanguageRange[] {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_ACCEPT_LANGUAGE_LENGTH) {
    return [];
  }

  const parsed: AcceptLanguageRange[] = [];
  const rawRanges = header.split(',');
  const rangeLimit = Math.min(rawRanges.length, MAX_ACCEPT_LANGUAGE_RANGES);
  for (let order = 0; order < rangeLimit; order += 1) {
    const parts = rawRanges[order]?.split(';') ?? [];
    const rawRange = parts.shift()?.trim() ?? '';
    if (rawRange !== '*' && !normalizeLocale(rawRange)) continue;

    let q = 1;
    let malformed = false;
    for (const parameter of parts) {
      const separator = parameter.indexOf('=');
      if (separator < 0) {
        malformed = true;
        break;
      }
      const name = parameter.slice(0, separator).trim().toLowerCase();
      if (name !== 'q') continue;
      const rawQ = parameter.slice(separator + 1).trim();
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQ)) {
        malformed = true;
        break;
      }
      q = Number(rawQ);
    }
    if (malformed || q <= 0) continue;

    parsed.push({
      range: rawRange === '*' ? '*' : normalizeLocale(rawRange)!,
      q,
      order,
    });
  }

  return parsed.sort((a, b) => b.q - a.q || a.order - b.order);
}

/**
 * Resolve a configured locale or an automatic browser locale against the
 * locales available to the current request.
 */
export function resolveLocale(
  configuredLocale: unknown,
  acceptLanguage: string | null | undefined,
  supportedLocales: Iterable<string>,
  catalogVersion = 'catalog-1',
): ResolvedLocale {
  const supported = normalizeSupportedLocales(supportedLocales);
  const fallback = supported.has(DEFAULT_LOCALE) ? DEFAULT_LOCALE : firstLocale(supported);
  const normalizedConfigured = normalizeLocale(configuredLocale);

  if (normalizedConfigured !== '') {
    const fixed = normalizedConfigured ? findSupportedLocale(normalizedConfigured, supported) : null;
    const locale = fixed || fallback;
    return {
      locale,
      bundleName: makeBundleName(locale, catalogVersion),
      source: fixed ? 'fixed' : 'fallback',
    };
  }

  for (const candidate of parseAcceptLanguage(acceptLanguage)) {
    if (candidate.range === '*') {
      return {
        locale: fallback,
        bundleName: makeBundleName(fallback, catalogVersion),
        source: 'fallback',
      };
    }
    const locale = findSupportedLocale(candidate.range, supported);
    if (locale) {
      return {
        locale,
        bundleName: makeBundleName(locale, catalogVersion),
        source: 'accept-language',
      };
    }
  }

  return {
    locale: fallback,
    bundleName: makeBundleName(fallback, catalogVersion),
    source: 'fallback',
  };
}

export function makeBundleName(locale: string, catalogVersion: string): string {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const version = catalogVersion.replace(/[^A-Za-z0-9._-]/g, '_') || 'catalog-1';
  return `${normalized}@${version}`;
}

/** Simple named interpolation. Translation values remain plain text. */
export function interpolateMessage(message: string, variables: MessageVariables = {}): string {
  return message.replace(/\{([A-Za-z0-9_.-]+)\}/g, (placeholder, name: string) => {
    const value = variables[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** Select a plural category without exposing Intl implementation details. */
export function selectPluralMessage(
  key: string,
  count: number,
  locale: string,
  lookup: (candidate: string) => string | undefined,
  variables: MessageVariables = {},
  fallbackText?: string,
): string {
  const pluralRule = getPluralRules(locale);
  const category = pluralRule.select(count);
  const candidates = [`${key}.${category}`];
  if (category !== 'other') candidates.push(`${key}.other`);
  candidates.push(key);

  const interpolationVariables = { ...variables, count };
  for (const candidate of candidates) {
    const message = lookup(candidate);
    if (message !== undefined) return interpolateMessage(message, interpolationVariables);
  }
  return interpolateMessage(fallbackText ?? key, interpolationVariables);
}

/** Create a request-local translator over global and optional scoped maps. */
export function createI18n(options: CreateI18nOptions): I18n {
  const locale = normalizeLocale(options.locale) || DEFAULT_LOCALE;
  const lookup = (key: string): string | undefined => {
    for (const candidateLocale of localeFallbackChain(locale)) {
      const scoped = getCatalog(options.scopedCatalogs, candidateLocale);
      if (scoped && hasMessage(scoped, key)) return scoped[key];
      const global = getCatalog(options.catalogs, candidateLocale);
      if (global && hasMessage(global, key)) return global[key];
    }
    return undefined;
  };

  return {
    locale,
    t(key, variables, fallbackText) {
      return interpolateMessage(lookup(key) ?? fallbackText ?? key, variables);
    },
    tPlural(key, count, variables, fallbackText) {
      return selectPluralMessage(key, count, locale, lookup, variables, fallbackText);
    },
  };
}

function normalizeSupportedLocales(locales: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const locale of locales) {
    const value = normalizeLocale(locale);
    if (value) normalized.add(value);
  }
  return normalized;
}

/** Match a configured locale against registered locales, accepting legacy aliases. */
export function matchSupportedLocale(raw: unknown, supportedLocales: Iterable<string>): string | null {
  const normalized = normalizeLocale(raw);
  if (normalized === null || normalized === '') return null;
  return findSupportedLocale(normalized, normalizeSupportedLocales(supportedLocales));
}

function firstLocale(locales: Set<string>): string {
  return locales.values().next().value || DEFAULT_LOCALE;
}

function findSupportedLocale(candidate: string, supported: Set<string>): string | null {
  if (supported.has(candidate)) return candidate;

  const parts = candidate.toLowerCase().split('-');
  const language = parts[0];
  if (!language) return null;

  const traditionalChinese = language === 'zh' && (
    parts.includes('hant') ||
    parts.some(part => part === 'tw' || part === 'hk' || part === 'mo')
  );
  if (traditionalChinese) return null;

  // Prefer an explicitly registered base locale, e.g. en for en-US.
  if (supported.has(language)) return language;

  // With the built-in catalogs, generic/simplified Chinese means zh-CN.
  if (language === 'zh' && supported.has('zh-CN')) {
    const scriptOrRegion = parts[1];
    if (!scriptOrRegion || scriptOrRegion.toLowerCase() === 'hans' ||
      ['cn', 'sg', 'my'].includes(scriptOrRegion.toLowerCase())) {
      return 'zh-CN';
    }
  }

  const familyMatches = [...supported].filter(locale => locale.toLowerCase().split('-')[0] === language);
  return familyMatches.length === 1 ? familyMatches[0] : null;
}

function localeFallbackChain(locale: string): string[] {
  const chain = [locale];
  const language = locale.split('-')[0];
  if (language !== locale) chain.push(language);
  if (!chain.includes(DEFAULT_LOCALE)) chain.push(DEFAULT_LOCALE);
  return chain;
}

function getCatalog(catalogs: TranslationCatalogs | undefined, locale: string): TranslationCatalog | undefined {
  if (!catalogs) return undefined;
  const maybeMap = catalogs as ReadonlyMap<string, TranslationCatalog>;
  if (typeof maybeMap.get === 'function') return maybeMap.get(locale);
  return (catalogs as Readonly<Record<string, TranslationCatalog>>)[locale];
}

function hasMessage(catalog: TranslationCatalog, key: string): key is keyof TranslationCatalog {
  return Object.prototype.hasOwnProperty.call(catalog, key);
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(locale: string): Intl.PluralRules {
  const existing = pluralRulesCache.get(locale);
  if (existing) return existing;
  const rules = new Intl.PluralRules(locale);
  pluralRulesCache.set(locale, rules);
  return rules;
}
