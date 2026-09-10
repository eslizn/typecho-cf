import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const themesPage = readFileSync(join(process.cwd(), 'src/pages/admin/themes.astro'), 'utf-8');
const configPage = readFileSync(join(process.cwd(), 'src/pages/admin/theme-config.astro'), 'utf-8');
const themeModule = readFileSync(join(process.cwd(), 'src/lib/theme.ts'), 'utf-8');
const defaultThemeManifest = JSON.parse(readFileSync(join(process.cwd(), 'src/themes/typecho-theme-minimal/theme.json'), 'utf-8')) as Record<string, unknown>;

describe('theme config admin UI', () => {
  it('does not expose configuration for the built-in default theme', () => {
    expect(defaultThemeManifest.config).toBeUndefined();
  });

  it('shows a settings entry only for themes that declare config', () => {
    expect(themesPage).toContain('themeHasConfig(theme.id)');
    expect(themesPage).toContain('/admin/theme-config?id=${theme.id}');
  });

  it('renders the shared form targeting the theme-config API with the theme id', () => {
    expect(configPage).toContain('action="/api/admin/theme-config"');
    expect(configPage).toContain('entityName="theme"');
    expect(configPage).toContain('entityId={themeId}');
  });

  it('redirects to the themes list when the theme has no config', () => {
    expect(configPage).toContain("Astro.redirect('/admin/themes')");
    expect(configPage).toContain('!theme || !themeHasConfig(themeId)');
  });

  it('keeps the admin menu and back link on the themes section', () => {
    expect(configPage).toContain('activeMenu="themes"');
    expect(configPage).toContain('backHref="/admin/themes"');
  });

  it('initializes the theme registry for API entrypoints without page-ssr', () => {
    expect(themeModule).toContain("from 'virtual:typecho-theme-registry'");
    expect(themeModule).toContain('for (const entry of themeRegistryEntries)');
  });

  it('keeps secret masking in the theme configuration view', () => {
    expect(configPage).toContain('getThemeConfigurationView');
  });
});
