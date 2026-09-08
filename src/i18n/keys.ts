/** Core keys are kept in one list so the English catalog cannot silently
 * drift behind the server-rendered core UI. Add a key here before using it
 * from core code. */
export const CORE_TRANSLATION_KEYS = [
  'core.locale.auto',
  'core.locale.zhCN',
  'core.locale.en',
  'core.error.forbidden',
  'core.error.notFound',
  'core.error.server',
  'core.error.serviceUnavailable',
] as const;

export type CoreTranslationKey = typeof CORE_TRANSLATION_KEYS[number];
