import { describe, expect, it } from 'vitest';
import Base from '@/layouts/Base.astro';
import { renderComponent } from './helpers';

const OPTIONS = {
  lang: 'en',
  charset: 'UTF-8',
  title: 'Test blog',
  theme: 'typecho-theme-minimal',
  themePreview: 'preview-theme',
};

describe('Base layout theme preview script', () => {
  it('emits executable inline navigation code', async () => {
    const html = await renderComponent(Base, {
      props: {
        title: 'Preview',
        options: OPTIONS,
        urls: { feedUrl: 'https://example.com/feed' },
      },
    });

    const script = html.match(/<script[^>]*data-preview-theme[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script.trimStart().startsWith('(() => {')).toBe(true);
    expect(script).not.toContain('`');
  });
});
