import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('search route params', () => {
  it('does not percent-decode the route param a second time', () => {
    // Astro already decodes route params (repeatedly, until stable), so the
    // extra decodeURIComponent threw URIError for "/search/50%25/" and turned
    // a public URL into a 500.
    const source = readFileSync(
      join(process.cwd(), 'src/pages/search/[...keywords].astro'),
      'utf-8',
    );

    expect(source).not.toContain('decodeURIComponent(');
    expect(source).toContain('const searchKeywords = (keywords || \'\').trim()');
  });
});
