import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const themeRoot = join(process.cwd(), 'src/themes/typecho-theme-paperline');
const headerComponents = ['Archive.astro', 'Index.astro', 'NotFound.astro', 'Page.astro', 'Post.astro'];

describe('Paperline search control', () => {
  it('keeps the icon button from inheriting the larger submit-button minimum height', () => {
    const stylesheet = readFileSync(
      join(themeRoot, 'style.css'),
      'utf8',
    );

    expect(stylesheet).toContain('#search button');
    expect(stylesheet).toContain('min-height: 24px;');
  });

  it('uses a stable inline vector icon in every header search form', () => {
    const stylesheet = readFileSync(join(themeRoot, 'style.css'), 'utf8');
    const searchButtonRule = stylesheet.match(/#search button\s*\{([\s\S]*?)\}/)?.[1] ?? '';

    expect(stylesheet).toContain('#search button .search-icon');
    expect(searchButtonRule).toContain('display: flex;');
    expect(searchButtonRule).toContain('align-items: center;');
    expect(searchButtonRule).toContain('justify-content: center;');
    for (const component of headerComponents) {
      const template = readFileSync(join(themeRoot, 'components', component), 'utf8');

      expect(template).toContain("theme.search.submit");
      expect(template).toContain('<svg class="search-icon"');
    }
  });
});
