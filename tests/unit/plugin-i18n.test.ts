import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addHook,
  getAvailableTranslationLocales,
  getGlobalTranslationCatalogs,
  registerPluginInit,
  resetPluginInitState,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';

function context(): HookContext {
  return { activatedPlugins: new Set<string>() };
}

afterEach(() => {
  resetPluginInitState();
});

describe('plugin translation registration', () => {
  it('merges active plugin catalogs in activation and registration order', async () => {
    registerPluginInit({
      'i18n-order-a': ({ registerTranslations }) => {
        registerTranslations('en', {
          'core.locale.en': 'A English',
          'plugin.a.only': 'A only',
        }, 'English from A');
        registerTranslations('fr-FR', { 'plugin.fr': 'Bonjour' }, 'Français');
      },
      'i18n-order-b': ({ registerTranslations }) => {
        registerTranslations('en', { 'core.locale.en': 'B English' }, 'English from B');
      },
    }, { addHook, HookPoints: {} as any });

    const ctx = context();
    await setActivatedPlugins(ctx, ['i18n-order-a', 'i18n-order-b']);
    const catalogs = getGlobalTranslationCatalogs(ctx.activatedPlugins);

    expect(catalogs.get('en')?.['core.locale.en']).toBe('B English');
    expect(catalogs.get('en')?.['plugin.a.only']).toBe('A only');
    expect(catalogs.get('fr-FR')?.['plugin.fr']).toBe('Bonjour');
    expect(getAvailableTranslationLocales(ctx.activatedPlugins)).toEqual([
      { locale: 'zh-CN' },
      { locale: 'en', displayName: 'English from B' },
      { locale: 'fr-FR', displayName: 'Français' },
    ]);
  });

  it('supports partial overrides and removes disabled plugin translations', async () => {
    registerPluginInit({
      'i18n-partial': ({ registerTranslations }) => {
        registerTranslations('zh-CN', { 'core.locale.en': '覆盖' });
      },
    }, { addHook, HookPoints: {} as any });

    const ctx = context();
    await setActivatedPlugins(ctx, ['i18n-partial']);
    expect(getGlobalTranslationCatalogs(ctx.activatedPlugins).get('zh-CN')?.['core.locale.en']).toBe('覆盖');

    await setActivatedPlugins(ctx, []);
    expect(getGlobalTranslationCatalogs(ctx.activatedPlugins).get('zh-CN')?.['core.locale.en']).toBe('English');
  });

  it('does not commit a catalog when plugin init fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPluginInit({
      'i18n-failed': ({ registerTranslations }) => {
        registerTranslations('en', { 'plugin.failed': 'must not leak' });
        throw new Error('init failed');
      },
    }, { addHook, HookPoints: {} as any });

    const ctx = context();
    await setActivatedPlugins(ctx, ['i18n-failed']);

    expect(getGlobalTranslationCatalogs(ctx.activatedPlugins).get('en')?.['plugin.failed']).toBeUndefined();
    errorSpy.mockRestore();
  });
});
