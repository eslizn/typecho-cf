import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const frontRoutes = [
  'src/pages/[slug].astro',
  'src/pages/archives/[cid].astro',
  'src/pages/category/[slug].astro',
  'src/pages/tag/[slug].astro',
  'src/pages/author/[uid].astro',
];

describe('front route 404 rendering', () => {
  it('renders the themed NotFound template instead of returning plain Not Found text', () => {
    for (const route of frontRoutes) {
      const source = readFileSync(join(process.cwd(), route), 'utf8');

      expect(source, route).toContain('prepareNotFoundData');
      expect(source, route).toContain('Astro.response.status = 404');
      expect(source, route).toContain('templates.NotFound ?? defaultTemplates.NotFound');
      expect(source, route).not.toContain("return new Response('Not Found'");
      expect(source, route).not.toContain('if (result instanceof Response) return result');
    }
  });
});
