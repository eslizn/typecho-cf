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

  it('restores inner spacing after option-tab styles reset padding', () => {
    const css = readProjectFile('public/css/admin.css');
    const tabsRule = css.indexOf('.typecho-option-tabs {');
    const noticeRule = css.indexOf('.typecho-option-tabs.admin-notice {');

    expect(noticeRule).toBeGreaterThan(tabsRule);
    expect(css).toContain('.typecho-option-tabs.admin-notice { padding: 10px 42px 10px 15px; }');
  });

  it('renders close buttons for server-rendered admin notices', () => {
    for (const page of [
      'src/pages/admin/plugins.astro',
      'src/pages/admin/themes.astro',
    ]) {
      const source = readProjectFile(page);

      expect(source, page).toContain('notice typecho-dismissible');
      expect(source, page).toContain('class="typecho-notice-close"');
      expect(source, page).toContain("admin.action.closeNotice");
    }
  });

  it('keeps login flash errors dismissible outside the admin layout', () => {
    const source = readProjectFile('src/pages/admin/login.astro');

    expect(source).toContain('message error typecho-dismissible');
    expect(source).toContain('class="typecho-notice-close"');
    expect(source).toContain("target.closest('.typecho-dismissible')");
  });

  it('uses the same dismissible structure for AI writer notices', () => {
    const source = readProjectFile('src/plugins/typecho-plugin-scribe/index.ts');

    expect(source).toContain('notice typecho-dismissible');
    expect(source).toContain("closeButton.className = 'typecho-notice-close'");
    expect(source).toContain("closeButton.setAttribute('aria-label', messages.close || '关闭提示')");
  });

  it('does not leak Turnstile plugin styles into global admin CSS', () => {
    const css = readProjectFile('public/css/admin.css');

    expect(css).not.toContain('.typecho-turnstile');
  });
});
