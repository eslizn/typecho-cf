/**
 * Guard for the admin list selection affordances.
 *
 * Regression: the row checkbox column used the responsive `kit-hidden-mb`
 * helper (hidden below 768px) while the pages still advertised bulk actions,
 * so on a narrow window there was no way to select a row at all. The select
 * column is now marked explicitly and the operate bar is flex-aligned, which
 * are CSS/markup contracts that cannot be asserted without a DOM harness.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADMIN_DIR = join(process.cwd(), 'src/pages/admin');

function pagesWithBulkActions(): string[] {
  return readdirSync(ADMIN_DIR)
    .filter((name) => name.endsWith('.astro'))
    .filter((name) => readFileSync(join(ADMIN_DIR, name), 'utf-8').includes('typecho-table-select-all'));
}

describe('admin list selection', () => {
  it('marks a select column on every page that offers bulk actions', () => {
    const pages = pagesWithBulkActions();
    expect(pages.length).toBeGreaterThan(0);

    for (const page of pages) {
      const source = readFileSync(join(ADMIN_DIR, page), 'utf-8');
      expect(source, `${page} needs a typecho-select-cell column`).toContain('typecho-select-cell');
    }
  });

  it('always renders a checkbox in the user list, including the current account', () => {
    // Regression: the current account's row rendered no checkbox at all, so a
    // single-user install showed an empty selection column and no way to tell
    // that bulk actions exist.
    const source = readFileSync(join(ADMIN_DIR, 'manage-users.astro'), 'utf-8');
    expect(source).toContain('name="uid[]"');
    expect(source).toContain('admin.user.selfSelect');
    expect(source).toContain('disabled');
  });

  it('keeps the select column and operate bar laid out by CSS, not by the responsive helper', () => {
    const css = readFileSync(join(process.cwd(), 'public/css/admin.css'), 'utf-8');

    expect(css).toContain('.typecho-list-table td.typecho-select-cell');
    expect(css).toContain('.typecho-list-operate .operate { display: flex; align-items: center;');
    expect(css).toContain('.btn-group { display: inline-block; vertical-align: middle; }');
  });
});
