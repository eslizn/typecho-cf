import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInstallArgs,
  collectTypechoPackageNames,
} from '../../scripts/reinstall-extensions.mjs';

const temporaryRoots: string[] = [];

function writePackage(directory: string, packageName: string, keywords: string[]): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: packageName,
    keywords,
  }));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('reinstall extensions command', () => {
  it('collects declared local and registry plugin/theme packages only', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-reinstall-extensions-'));
    temporaryRoots.push(root);

    writePackage(join(root, 'src', 'plugins', 'local-plugin'), 'local-plugin', ['typecho', 'plugin']);
    writePackage(join(root, 'node_modules', 'external-theme'), 'external-theme', ['typecho', 'theme']);
    writePackage(join(root, 'node_modules', 'unlisted-plugin'), 'unlisted-plugin', ['typecho', 'plugin']);
    writePackage(join(root, 'node_modules', 'ordinary-package'), 'ordinary-package', ['utility']);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        'local-plugin': 'file:src/plugins/local-plugin',
        'external-theme': '1.0.0',
        'ordinary-package': '1.0.0',
      },
    }));

    expect(collectTypechoPackageNames(root)).toEqual(['local-plugin', 'external-theme']);
  });

  it('recognizes Windows file dependency paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-reinstall-extensions-'));
    temporaryRoots.push(root);

    const localName = 'typecho-plugin-windows-path';
    writePackage(join(root, 'src', 'plugins', localName), localName, ['typecho', 'plugin']);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        [localName]: `file:src\\plugins\\${localName}`,
      },
    }));

    expect(collectTypechoPackageNames(root)).toEqual([localName]);
  });

  it('builds a forced install command without updating dependency ranges', () => {
    expect(buildInstallArgs()).toEqual(['install', '--force', '--frozen-lockfile']);
  });
});
