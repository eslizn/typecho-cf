import { describe, expect, it } from 'vitest';
import {
  createI18n,
  interpolateMessage,
  matchSupportedLocale,
  parseAcceptLanguage,
  resolveLocale,
  type TranslationCatalog,
} from '@/lib/i18n';

const supported = ['zh-CN', 'en'];

describe('parseAcceptLanguage()', () => {
  it('sorts by q-value and preserves source order for ties', () => {
    expect(parseAcceptLanguage('en-US;q=0.8, zh-CN, fr;q=0.8').map(item => item.range)).toEqual([
      'zh-CN',
      'en-US',
      'fr',
    ]);
  });

  it('ignores q=0 and malformed ranges', () => {
    expect(parseAcceptLanguage('fr;q=0, ???, en-US;q=0.7').map(item => item.range)).toEqual(['en-US']);
  });

  it('caps processed ranges and rejects an oversized header', () => {
    const ranges = Array.from({ length: 30 }, () => 'en-US;q=0.5').join(',');
    expect(parseAcceptLanguage(ranges)).toHaveLength(20);
    expect(parseAcceptLanguage('en,'.padEnd(4097, 'x'))).toEqual([]);
  });

  it('caps the first 20 raw ranges before discarding invalid entries', () => {
    const header = [...Array.from({ length: 20 }, () => '???'), 'fr'].join(',');
    expect(parseAcceptLanguage(header)).toEqual([]);
  });
});

describe('resolveLocale()', () => {
  it('uses an exact browser match when lang is empty', () => {
    expect(resolveLocale('', 'en-US,en;q=0.9', supported, 'catalog-1')).toEqual({
      locale: 'en',
      bundleName: 'en@catalog-1',
      source: 'accept-language',
    });
  });

  it('maps simplified Chinese browser languages to zh-CN', () => {
    expect(resolveLocale('', 'zh-Hans-CN,zh;q=0.8', supported).locale).toBe('zh-CN');
    expect(resolveLocale('', 'zh-CN', supported).locale).toBe('zh-CN');
  });

  it('does not map traditional Chinese to zh-CN', () => {
    expect(resolveLocale('', 'zh-TW,zh-Hant;q=0.9', supported).locale).toBe('en');
  });

  it('uses en when the browser language cannot be supported', () => {
    expect(resolveLocale('', 'fr-CA,ja;q=0.8', supported).source).toBe('fallback');
    expect(resolveLocale('', null, supported).locale).toBe('en');
  });

  it('does not read Accept-Language for a fixed locale', () => {
    expect(resolveLocale('zh_CN', 'en-US', supported).source).toBe('fixed');
    expect(resolveLocale('zh_CN', 'en-US', supported).locale).toBe('zh-CN');
    expect(resolveLocale('fr', 'zh-CN', supported).locale).toBe('en');
  });

  it('uses a unique plugin-provided family locale', () => {
    expect(resolveLocale('', 'fr-CA', ['en', 'fr-FR']).locale).toBe('fr-FR');
    expect(resolveLocale('', 'fr', ['en', 'fr-FR', 'fr-CA']).locale).toBe('en');
  });

  it('matches configured aliases only against registered locales', () => {
    expect(matchSupportedLocale('en-US', supported)).toBe('en');
    expect(matchSupportedLocale('zh_CN', supported)).toBe('zh-CN');
    expect(matchSupportedLocale('fr-FR', supported)).toBeNull();
  });

  it('does not let a wildcard choose an arbitrary plugin locale', () => {
    expect(resolveLocale('', '*', ['en', 'fr-FR']).locale).toBe('en');
  });
});

describe('I18n', () => {
  const catalogs = new Map<string, TranslationCatalog>([
    ['en', {
      'core.greeting': 'Hello, {name}!',
      'items.one': '{count} item',
      'items.other': '{count} items',
      'fallback.only': 'English fallback',
    }],
    ['zh-CN', {
      'core.greeting': '你好，{name}！',
      'items.other': '{count} 个项目',
    }],
  ]);

  it('resolves scoped messages before global messages', () => {
    const i18n = createI18n({
      locale: 'zh-CN',
      catalogs,
      scopedCatalogs: new Map([
        ['zh-CN', { 'core.greeting': '主题你好，{name}！' }],
      ]),
    });

    expect(i18n.t('core.greeting', { name: 'Ada' })).toBe('主题你好，Ada！');
    expect(i18n.t('fallback.only')).toBe('English fallback');
  });

  it('uses fallback text and leaves unknown keys understandable', () => {
    const i18n = createI18n({ locale: 'en', catalogs });
    expect(i18n.t('missing', { name: 'Ada' }, 'Missing {name}')).toBe('Missing Ada');
    expect(i18n.t('missing')).toBe('missing');
  });

  it('interpolates only simple named variables', () => {
    expect(interpolateMessage('{name} {count} {missing}', { name: '<Ada>', count: 2 })).toBe(
      '<Ada> 2 {missing}',
    );
  });

  it('selects plural messages using the resolved locale', () => {
    const i18n = createI18n({ locale: 'en', catalogs });
    expect(i18n.tPlural('items', 1)).toBe('1 item');
    expect(i18n.tPlural('items', 2)).toBe('2 items');
  });
});
