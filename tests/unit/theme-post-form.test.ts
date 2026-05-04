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
});
