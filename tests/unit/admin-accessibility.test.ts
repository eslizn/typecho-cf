import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('admin accessibility contracts', () => {
  it.each([
    'src/pages/admin/login.astro',
    'src/pages/admin/reset-password.astro',
  ])('%s permits browser zoom', (path) => {
    const source = read(path);
    expect(source).not.toContain('maximum-scale');
    expect(source).not.toContain('user-scalable=no');
  });

  it('gives rendered batch dropdowns explicit menu relationships', () => {
    for (const path of [
      'src/pages/admin/manage-posts.astro',
      'src/pages/admin/manage-comments.astro',
      'src/pages/admin/manage-medias.astro',
      'src/pages/admin/manage-pages.astro',
      'src/pages/admin/manage-users.astro',
      'src/pages/admin/manage-categories.astro',
      'src/pages/admin/manage-tags.astro',
    ]) {
      const source = read(path);
      expect(source).toContain('aria-haspopup="menu"');
      expect(source).toContain('aria-controls=');
      expect(source).toContain('role="menu"');
    }
  });

  it('provides a visible keyboard focus treatment', () => {
    expect(read('public/css/admin.css')).toContain(':focus-visible');
    expect(read('public/css/admin.css')).toContain('#E47E00');
  });
});
