import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverThemes } from '@/integrations/theme-loader';

const temporaryRoots: string[] = [];

function writeTheme(directory: string, config: Record<string, unknown> | undefined): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'typecho-theme-fixture',
    keywords: ['typecho', 'theme'],
  }));
  writeFileSync(join(directory, 'theme.json'), JSON.stringify({
    id: 'typecho-theme-fixture',
    name: 'Fixture',
    ...(config ? { config } : {}),
  }));
  writeFileSync(join(directory, 'style.css'), 'body {}');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('theme loader local file dependencies', () => {
  it('prefers the current source manifest over a stale node_modules snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-theme-loader-'));
    temporaryRoots.push(root);

    writeTheme(join(root, 'node_modules', 'typecho-theme-fixture'), undefined);
    writeTheme(join(root, 'src', 'themes', 'typecho-theme-fixture'), {
      footerText: { type: 'text', label: 'Footer text' },
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        'typecho-theme-fixture': 'file:src/themes/typecho-theme-fixture',
      },
    }));

    const [theme] = discoverThemes(root);

    expect(theme.packageDir).toBe(join(root, 'src', 'themes', 'typecho-theme-fixture'));
    expect(theme.manifest.config).toEqual({
      footerText: { type: 'text', label: 'Footer text' },
    });
  });

  it('ignores an unlisted theme that only exists in node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'typecho-theme-loader-'));
    temporaryRoots.push(root);

    writeTheme(join(root, 'node_modules', 'typecho-theme-unlisted'), undefined);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));

    expect(discoverThemes(root)).toEqual([]);
  });
});
