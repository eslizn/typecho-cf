import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin plugin config page', () => {
  it('filters R2 binding choices to bucket-like bindings when possible', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
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
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source).toContain('data-label={field.label}');
    expect(source).toContain('function renumberRepeatableItems(root)');
    expect(source).toContain("legend.textContent = label + ' #' + String(index + 1)");
    expect(source.match(/renumberRepeatableItems\(root\)/g)).toHaveLength(3);
  });

  it('does not expose configurable WebDAV access rules', () => {
    const manifest = JSON.parse(readFileSync(
      join(process.cwd(), 'src/plugins/typecho-plugin-webdav/plugin.json'),
      'utf-8',
    ));

    expect(manifest.config.requiredGroup).toBeUndefined();
    expect(manifest.config.mounts.itemFields.allowedUsers).toBeUndefined();
  });

  it('defaults the WebDAV entry route to /webdav', () => {
    const manifest = JSON.parse(readFileSync(
      join(process.cwd(), 'src/plugins/typecho-plugin-webdav/plugin.json'),
      'utf-8',
    ));

    expect(manifest.config.routePath.default).toBe('/webdav');
    expect(manifest.config.routePath.description).toContain('/webdav');
  });

  it('defaults WebDAV mounts to the route root and whole bucket', () => {
    const manifest = JSON.parse(readFileSync(
      join(process.cwd(), 'src/plugins/typecho-plugin-webdav/plugin.json'),
      'utf-8',
    ));

    expect(manifest.config.mounts.default[0].mount).toBe('');
    expect(manifest.config.mounts.default[0].prefix).toBe('');
    expect(manifest.config.mounts.itemFields.mount.default).toBe('');
    expect(manifest.config.mounts.itemFields.prefix.default).toBe('');
  });
});
