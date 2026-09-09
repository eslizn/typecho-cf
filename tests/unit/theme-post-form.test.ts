/**
 * Regression tests for the default post comment form.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('default post comment form', () => {
  it('renders the anti-spam token hidden input when provided', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/themes/typecho-theme-minimal/components/Post.astro'),
      'utf-8',
    );

    expect(source).toContain('commentOptions.securityToken');
    expect(source).toContain('name="_"');
    expect(source).toContain('value={commentOptions.securityToken}');
  });

  it('uses a theme translation for the comment email label in every bundled theme', () => {
    for (const theme of ['typecho-theme-minimal', 'typecho-theme-paperline']) {
      for (const component of ['Post', 'Page']) {
        const source = readFileSync(
          join(process.cwd(), 'src/themes', theme, 'components', `${component}.astro`),
          'utf-8',
        );
        expect(source).toContain("t('theme.comments.email', {}, 'Email')");
      }
    }
  });

  it('renders the localized footer suffix after the linked platform name', () => {
    for (const theme of ['typecho-theme-minimal', 'typecho-theme-paperline']) {
      for (const component of ['Index', 'Post', 'Page', 'Archive', 'NotFound']) {
        const source = readFileSync(
          join(process.cwd(), 'src/themes', theme, 'components', `${component}.astro`),
          'utf-8',
        );
        expect(source).toContain("t('theme.footer.poweredBySuffix', {}, '')");
      }
      const zh = JSON.parse(readFileSync(join(process.cwd(), 'src/themes', theme, 'locales/zh-CN.json'), 'utf-8'));
      expect(zh['theme.footer.poweredBySuffix']).toBe(' 驱动');
    }
  });
});
