import {
  createI18n,
  normalizeLocale,
  resolveLocale,
  type I18n,
  type ResolvedLocale,
} from '@/lib/i18n';
import {
  getGlobalTranslationCatalogs,
  getTranslationCatalogVersion,
} from '@/lib/i18n-registry';

export interface RequestI18nRuntime {
  i18n: I18n;
  resolvedLocale: ResolvedLocale;
  autoLocale: boolean;
}

/** Build the global translator for one request and one active-plugin set. */
export function createRequestI18n(
  configuredLocale: unknown,
  request: Request,
  activePluginIds: Iterable<string>,
): RequestI18nRuntime {
  const catalogs = getGlobalTranslationCatalogs(activePluginIds);
  const catalogVersion = getTranslationCatalogVersion(activePluginIds);
  const resolvedLocale = resolveLocale(
    configuredLocale,
    request.headers.get('Accept-Language'),
    catalogs.keys(),
    catalogVersion,
  );

  return {
    i18n: createI18n({ locale: resolvedLocale.locale, catalogs }),
    resolvedLocale,
    autoLocale: normalizeLocale(configuredLocale) === '',
  };
}

/** Resolve a locale before site options exist, e.g. install and bootstrap errors. */
export function createCoreRequestI18n(request: Request): RequestI18nRuntime {
  return createRequestI18n('', request, []);
}
