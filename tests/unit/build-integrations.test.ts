import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pluginLoader = readFileSync(
  join(process.cwd(), 'src/integrations/plugin-loader.ts'),
  'utf8',
);
const themeLoader = readFileSync(
  join(process.cwd(), 'src/integrations/theme-loader.ts'),
  'utf8',
);

describe('build-time plugin and theme registries', () => {
  it('keeps plugin registration in the middleware virtual module only', () => {
    expect(pluginLoader).toContain('virtual:typecho-plugin-registry');
    expect(pluginLoader).toContain('registerPluginLoaders');
    expect(pluginLoader).not.toContain("injectScript('page-ssr'");
    expect(pluginLoader).not.toContain('page-ssr');
  });

  it('keeps theme registration in the shared virtual registry only', () => {
    expect(themeLoader).toContain('virtual:typecho-theme-registry');
    expect(themeLoader).toContain('generateThemeRegistryModule');
    expect(themeLoader).not.toContain('injectScript');
    expect(themeLoader).not.toContain('page-ssr');
  });
});
