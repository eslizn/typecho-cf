import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  join(process.cwd(), 'src/themes/typecho-theme-paperline/style.css'),
  'utf8',
);

describe('Paperline list excerpts', () => {
  it('clamps only excerpts that have no read-more divider', () => {
    const selector = '.post:has(h2.post-title) .post-content:not(:has(.more))';
    expect(stylesheet).toContain(selector);

    const rule = stylesheet
      .match(/\.post:has\(h2\.post-title\) \.post-content:not\(:has\(\.more\)\)\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(rule).toContain('-webkit-line-clamp: 3;');

    // The old rule clamped every list excerpt, including ones ending in a
    // <!--more--> divider, hiding the author-defined excerpt and its link.
    expect(stylesheet).not.toMatch(/\.post:has\(h2\.post-title\) \.post-content\s*\{/);
  });
});
