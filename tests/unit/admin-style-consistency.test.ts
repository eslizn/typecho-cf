import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('admin style consistency contracts', () => {
  it('defines reusable admin surfaces, notices, badges, and action rows', () => {
    const css = read('public/css/admin.css');

    expect(css).toContain('.admin-panel');
    expect(css).toContain('.admin-notice');
    expect(css).toContain('.admin-badge');
    expect(css).toContain('.admin-actions');
    expect(css).toContain('.admin-inline-form');
    expect(css).toContain('.typecho-mini-panel');
    expect(css).toContain('.typecho-content-panel');
  });

  it('keeps shared notices left-aligned and exposes semantic variants', () => {
    const css = read('public/css/admin.css');

    expect(css).toContain('.admin-notice {');
    expect(css).toContain('text-align: left;');
    expect(css).toContain('.admin-notice--success');
    expect(css).toContain('.admin-notice--error');
    expect(css).toContain('.admin-notice--warning');
  });

  it('normalizes full-size and compact form controls', () => {
    const css = read('public/css/admin.css');

    expect(css).toContain('input[type=datetime-local]');
    expect(css).toContain('input[type=number]');
    expect(css).toContain('.typecho-list-operate select { height: 28px; }');
  });
});
