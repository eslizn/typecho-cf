import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverPluginClients } from '@/integrations/client-loader';

const temporaryRoots: string[] = [];

function writePlugin(directory: string, packageName: string): void {
  mkdirSync(join(directory, 'client'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: packageName,
    keywords: ['typecho', 'plugin'],
    typecho: { plugin: { id: packageName, name: packageName } },
  }));
  writeFileSync(join(directory, 'index.ts'), 'export default function init() {}');
  writeFileSync(join(directory, 'client', 'editor.ts'), 'console.log("editor");');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('client loader declared plugins', () => {
  it('compiles client sources only for discovered plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-client-loader-'));
    temporaryRoots.push(root);

    const declaredName = 'typecho-plugin-declared';
    const unlistedName = 'typecho-plugin-unlisted';
    writePlugin(join(root, 'src', 'plugins', declaredName), declaredName);
    writePlugin(join(root, 'src', 'plugins', unlistedName), unlistedName);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        [declaredName]: `file:src/plugins/${declaredName}`,
      },
    }));

    const sources = discoverPluginClients(root);

    expect(sources).toHaveLength(1);
    expect(sources[0].publicUrl).toBe(`/plugin-assets/${declaredName}/editor.js`);
    expect(sources[0].sourcePath).toBe(join(root, 'src', 'plugins', declaredName, 'client', 'editor.ts'));
  });
});
