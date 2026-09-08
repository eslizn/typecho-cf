import { describe, expect, it } from 'vitest';
import { coreCatalogs } from '@/i18n/catalogs';
import { CORE_TRANSLATION_KEYS } from '@/i18n/keys';

describe('core translation catalogs', () => {
  it('provides the built-in locales', () => {
    expect(coreCatalogs.has('zh-CN')).toBe(true);
    expect(coreCatalogs.has('en')).toBe(true);
  });

  it('keeps the English catalog complete and string-only', () => {
    const english = coreCatalogs.get('en');
    expect(english).toBeDefined();
    for (const key of CORE_TRANSLATION_KEYS) {
      expect(english).toHaveProperty(key);
      expect(typeof english?.[key]).toBe('string');
    }
    for (const value of Object.values(english || {})) {
      expect(typeof value).toBe('string');
    }
  });
});
