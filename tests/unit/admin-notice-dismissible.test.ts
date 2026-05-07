import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('admin dismissible notices', () => {
  it('places the close button on the right side and vertically centers it', () => {
    const css = readProjectFile('public/css/admin.css');

    expect(css).toContain('.typecho-dismissible { position: relative; padding-right: 42px !important; }');
    expect(css).toContain('.typecho-notice-close { position: absolute; top: 50%; right: 10px;');
    expect(css).toContain('transform: translateY(-50%)');
  });

  it('binds a shared admin notice close handler', () => {
    const source = readProjectFile('src/layouts/Admin.astro');

    expect(source).toContain("'.typecho-notice-close'");
    expect(source).toContain("closest('.typecho-dismissible').remove()");
  });

  it('renders close buttons for server-rendered admin notices', () => {
    for (const page of [
      'src/pages/admin/plugins.astro',
      'src/pages/admin/themes.astro',
      'src/pages/admin/plugin-config.astro',
    ]) {
      const source = readProjectFile(page);

      expect(source, page).toContain('notice typecho-dismissible');
      expect(source, page).toContain('class="typecho-notice-close"');
      expect(source, page).toContain('aria-label="关闭提示"');
    }
  });

  it('keeps login flash errors dismissible outside the admin layout', () => {
    const source = readProjectFile('src/pages/admin/login.astro');

    expect(source).toContain('message error typecho-dismissible');
    expect(source).toContain('class="typecho-notice-close"');
    expect(source).toContain("target.closest('.typecho-dismissible')");
  });

  it('uses the same dismissible structure for AI writer notices', () => {
    const source = readProjectFile('src/plugins/typecho-plugin-ai-writer/index.ts');

    expect(source).toContain('notice typecho-dismissible');
    expect(source).toContain("closeButton.className = 'typecho-notice-close'");
    expect(source).toContain("closeButton.setAttribute('aria-label', '关闭提示')");
  });

  it('does not leak Turnstile plugin styles into global admin CSS', () => {
    const css = readProjectFile('public/css/admin.css');

    expect(css).not.toContain('.typecho-turnstile');
  });
});
