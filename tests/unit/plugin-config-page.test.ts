import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadWebdavManifest() {
  const pkg = JSON.parse(readFileSync(
    join(process.cwd(), 'src/plugins/typecho-plugin-webdav/package.json'),
    'utf-8',
  ));
  return pkg.typecho.plugin;
}

describe('admin plugin config page', () => {
  it('filters R2 binding choices to bucket-like bindings when possible', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/admin/ConfigForm.astro'),
      'utf-8',
    );

    expect(source).toContain("typeof (value as any).get === 'function'");
    expect(source).toContain("typeof (value as any).put === 'function'");
    expect(source).toContain("typeof (value as any).delete === 'function'");
    expect(source).toContain("typeof (value as any).head === 'function'");
    expect(source).toContain("typeof (value as any).list === 'function'");
  });

  it('renumbers repeatable legends after add or remove actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/admin/ConfigForm.astro'),
      'utf-8',
    );

    expect(source).toContain('data-label={field.label}');
    expect(source).toContain('function renumberRepeatableItems(root)');
    expect(source).toContain("legend.textContent = label + ' #' + String(index + 1)");
    expect(source.match(/renumberRepeatableItems\(root\)/g)).toHaveLength(3);
  });

  it('submits stable row metadata with existing repeatable rows', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/admin/ConfigForm.astro'),
      'utf-8',
    );

    expect(source).toContain('CONFIG_ROW_ID');
    expect(source).toContain('row[CONFIG_ROW_ID]');
  });

  it('renders normalized root repeatable paths as slash values', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/admin/ConfigForm.astro'),
      'utf-8',
    );

    expect(source).toContain('function displayRepeatableValue');
    expect(source).toContain("field.type === 'text' && field.default === '/' && value === ''");
    expect(source).toContain("value && !value.startsWith('/')");
  });

  it('renders boolean select values as manifest option strings', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/admin/ConfigForm.astro'),
      'utf-8',
    );

    expect(source).toContain('function fieldValueForOption');
    expect(source).toContain('function selectedAttr');
    expect(source).toContain("typeof value === 'boolean'");
    expect(source).toContain('data-current-value={fieldValueForOption(value)}');
    expect(source).toContain('selected={selectedAttr(value, optVal)}');
    expect(source).toContain("document.querySelectorAll('select[data-current-value]')");
    expect(source).toContain("select.value = select.getAttribute('data-current-value') || ''");
  });

  it('registers WebDAV request:route via lazy init, not hardcoded import', () => {
    const middlewareSource = readFileSync(
      join(process.cwd(), 'src/middleware.ts'),
      'utf-8',
    );
    const pluginSource = readFileSync(
      join(process.cwd(), 'src/lib/plugin.ts'),
      'utf-8',
    );

    // middleware.ts must NOT hardcode any WebDAV import
    expect(middlewareSource).not.toContain("from '@/plugins/typecho-plugin-webdav/index'");
    expect(middlewareSource).not.toContain("from 'typecho-plugin-webdav");

    // middleware.ts uses setActivatedPlugins which triggers lazy init
    expect(middlewareSource).toContain('setActivatedPlugins');

    // plugin.ts filters hooks by ctx.activatedPlugins (lazy-init safety net)
    expect(pluginSource).toContain('ctx.activatedPlugins.has(reg.pluginId)');
  });

  it('routes plugin configuration writes through the canonical save module', () => {
    const pluginConfigSource = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );
    const pluginsSource = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugins.astro'),
      'utf-8',
    );
    const themesSource = readFileSync(
      join(process.cwd(), 'src/pages/admin/themes.astro'),
      'utf-8',
    );
    const pluginConfigModule = readFileSync(
      join(process.cwd(), 'src/lib/plugin-config.ts'),
      'utf-8',
    );

    expect(pluginConfigSource).toContain('action="/api/admin/plugin-config"');
    expect(pluginConfigSource).toContain('getPluginConfigurationView(options, pluginId)');
    expect(pluginConfigSource).not.toContain('setOption(ctx.db');
    expect(pluginConfigModule).toContain('await setOption(auth.db, `plugin:${pluginId}`');
    expect(pluginConfigModule).toContain("await purgeSiteCache(auth.options.siteUrl || '')");
    expect(pluginsSource).toContain('bumpCacheVersion(db)');
    expect(themesSource).toContain('bumpCacheVersion(ctx.db)');
  });

  it('does not expose configurable WebDAV access rules', () => {
    const manifest = loadWebdavManifest();
    expect(manifest.config.requiredGroup).toBeUndefined();
    expect(manifest.config.mounts.itemFields.allowedUsers).toBeUndefined();
  });

  it('defaults the WebDAV entry route to /webdav', () => {
    const manifest = loadWebdavManifest();
    expect(manifest.config.routePath.default).toBe('/webdav');
    expect(manifest.config.routePath.description).toContain('/webdav');
  });

  it('defaults WebDAV mounts to the route root and whole bucket', () => {
    const manifest = loadWebdavManifest();
    expect(manifest.config.mounts.default[0].mount).toBe('/');
    expect(manifest.config.mounts.default[0].prefix).toBe('');
    expect(manifest.config.mounts.itemFields.mount.default).toBe('/');
    expect(manifest.config.mounts.itemFields.prefix.default).toBe('');
  });
});
