import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverPlugins } from '@/integrations/plugin-loader';

const temporaryRoots: string[] = [];

function writePlugin(directory: string, packageName: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: packageName,
    keywords: ['typecho', 'plugin'],
    typecho: { plugin: { id: packageName, name: packageName } },
  }));
  writeFileSync(join(directory, 'index.ts'), 'export default function init() {}');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin loader declared dependencies', () => {
  it('ignores a typecho plugin that is only present in node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    writePlugin(join(root, 'node_modules', 'typecho-plugin-unlisted'), 'typecho-plugin-unlisted');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));

    expect(discoverPlugins(root)).toEqual([]);
  });

  it('discovers declared local and registry-style plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-plugin-loader-'));
    temporaryRoots.push(root);

    const localName = 'typecho-plugin-local';
    const externalName = 'typecho-plugin-external';
    writePlugin(join(root, 'src', 'plugins', localName), localName);
    writePlugin(join(root, 'node_modules', externalName), externalName);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        [localName]: `file:src/plugins/${localName}`,
        [externalName]: '1.0.0',
      },
    }));

    const plugins = discoverPlugins(root);

    expect(plugins.map(plugin => plugin.packageName)).toEqual([localName, externalName]);
    expect(plugins[0].importPath).toBe(`/src/plugins/${localName}/index.ts`);
    expect(plugins[1].importPath).toBe(`${externalName}/index.ts`);
  });
});
