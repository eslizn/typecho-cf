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
  it('registers WebDAV request:route via lazy init, not hardcoded import', () => {
    const middlewareSource = readFileSync(
      join(process.cwd(), 'src/middleware.ts'),
      'utf-8',
    );
    // Hook registration and dispatch moved to lib/hooks.ts; keep the
    // lazy-init safety net assertion pointed at its current home.
    const pluginSource = readFileSync(
      join(process.cwd(), 'src/lib/hooks.ts'),
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
