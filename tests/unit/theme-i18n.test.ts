import { describe, expect, it } from 'vitest';
import { createI18n } from '@/lib/i18n';
import { createThemeI18n, registerTheme } from '@/lib/theme';

describe('theme-scoped translations', () => {
  it('prefers the active theme catalog while retaining global fallback', () => {
    const themeId = 'typecho-theme-i18n-scope-test';
    registerTheme('typecho-theme-i18n-scope-test', {
      id: themeId,
      name: 'Theme i18n scope test',
    }, `/themes/${themeId}/style.css`, {
      en: {
        'core.locale.en': 'Theme English',
        'theme.only': 'Theme-only message',
      },
    });

    const global = createI18n({ locale: 'en', catalogs: {} });
    const i18n = createThemeI18n(themeId, global);

    expect(i18n.t('core.locale.en')).toBe('Theme English');
    expect(i18n.t('core.error.forbidden')).toBe('Forbidden');
    expect(i18n.t('theme.only')).toBe('Theme-only message');
  });

  it('does not make theme-only messages visible through the global translator', () => {
    const themeId = 'typecho-theme-i18n-isolation-test';
    registerTheme('typecho-theme-i18n-isolation-test', {
      id: themeId,
      name: 'Theme i18n isolation test',
    }, `/themes/${themeId}/style.css`, {
      en: { 'theme.private': 'Private' },
    });

    const global = createI18n({ locale: 'en', catalogs: {} });
    const theme = createThemeI18n(themeId, global);

    expect(theme.t('theme.private')).toBe('Private');
    expect(global.t('theme.private')).toBe('theme.private');
  });
});
