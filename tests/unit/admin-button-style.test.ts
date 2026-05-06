import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function adminCss(): string {
  return readFileSync(join(process.cwd(), 'public/css/admin.css'), 'utf-8');
}

function ruleFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}[^{}]*\\{([^}]*)\\}`))?.[1] || '';
}

describe('admin button sizing styles', () => {
  it('keeps sized buttons vertically centered by matching height and line-height', () => {
    const css = adminCss();

    expect(ruleFor(css, '.btn-xs')).toContain('height: 25px; line-height: 25px;');
    expect(ruleFor(css, '.btn-s')).toContain('height: 28px; line-height: 28px;');
    expect(ruleFor(css, '.btn-l')).toContain('height: 40px; line-height: 40px;');
  });

  it('uses the shared small button style for repeatable remove buttons', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/pages/admin/plugin-config.astro'),
      'utf-8',
    );

    expect(source.match(/class="btn btn-xs typecho-repeatable-remove"/g)).toHaveLength(2);
  });
});
