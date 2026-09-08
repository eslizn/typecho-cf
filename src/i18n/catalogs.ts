import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import type { TranslationCatalog } from '@/lib/i18n';

export const coreCatalogs = new Map<string, TranslationCatalog>([
  ['zh-CN', zhCN],
  ['en', en],
]);

export const CORE_LOCALES = ['zh-CN', 'en'] as const;
