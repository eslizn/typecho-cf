/**
 * Unit tests for src/lib/markdown.ts
 *
 * Key concern: <!--more--> must NOT be split on before rendering.
 * The full markdown source (both sides of the marker) must be parsed in
 * a single pass so that reference-style links, footnotes, and other
 * constructs that span the boundary are resolved correctly.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderContentExcerpt, generateExcerpt, renderCommentText } from '@/lib/markdown';

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('renders basic markdown to HTML', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('strips <!--markdown--> prefix', () => {
    const html = renderMarkdown('<!--markdown-->*em*');
    expect(html).toContain('<em>em</em>');
    expect(html).not.toContain('<!--markdown-->');
  });

  it('removes <!--more--> from output', () => {
    const html = renderMarkdown('before<!--more-->after');
    expect(html).not.toContain('more');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('resolves reference-style links defined after <!--more-->', () => {
    // The link definition [foo]: ... sits after <!--more-->.
    // renderMarkdown must render the whole document, so [link][foo] should resolve.
    const src = 'See [link][foo]<!--more-->\n\n[foo]: https://example.com';
    const html = renderMarkdown(src);
    expect(html).toContain('href="https://example.com"');
  });
});

// ---------------------------------------------------------------------------
// renderContentExcerpt
// ---------------------------------------------------------------------------

describe('renderContentExcerpt', () => {
  it('returns full rendered HTML when no <!--more--> present', () => {
    const html = renderContentExcerpt('hello **world**');
    expect(html).toContain('<strong>world</strong>');
    expect(html).not.toContain('more');
  });

  it('truncates at <!--more--> and appends read-more link', () => {
    const html = renderContentExcerpt('intro<!--more-->rest', '继续阅读', '/post/1/');
    expect(html).toContain('intro');
    expect(html).not.toContain('rest');
    expect(html).toContain('继续阅读');
    expect(html).toContain('href="/post/1/"');
  });

  it('resolves reference-style links defined AFTER <!--more-->', () => {
    // Critical regression test: link def is on the "rest" side of <!--more-->.
    // The excerpt must still render [click][ref] as a proper anchor.
    const src = '[click][ref]<!--more-->\n\n[ref]: https://example.org "Example"';
    const html = renderContentExcerpt(src, 'more', '/p/');
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('click');
    // The link definition raw text should not appear as visible content
    expect(html).not.toContain('[ref]:');
  });

  it('resolves reference-style links defined BEFORE <!--more-->', () => {
    const src = '[ref]: https://example.net\n\nbefore [click][ref]<!--more-->after';
    const html = renderContentExcerpt(src, 'more', '/p/');
    expect(html).toContain('href="https://example.net"');
    expect(html).not.toContain('after');
  });

  it('handles multiple <!--more--> markers (only first split matters)', () => {
    const html = renderContentExcerpt('a<!--more-->b<!--more-->c', 'more', '/p/');
    expect(html).toContain('>a<');
    expect(html).not.toContain('>b<');
    expect(html).not.toContain('>c<');
  });

  it('strips <!--markdown--> prefix', () => {
    const html = renderContentExcerpt('<!--markdown-->**bold**<!--more-->rest');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<!--markdown-->');
  });
});

// ---------------------------------------------------------------------------
// generateExcerpt
// ---------------------------------------------------------------------------

describe('generateExcerpt', () => {
  it('returns plain text without tags', () => {
    const text = generateExcerpt('**hello** world');
    expect(text).not.toContain('<');
    expect(text).toContain('hello');
  });

  it('truncates at maxLength', () => {
    const long = 'a'.repeat(300);
    const text = generateExcerpt(long, 100);
    expect(text.length).toBeLessThanOrEqual(103); // 100 + '...'
    expect(text.endsWith('...')).toBe(true);
  });

  it('does not include <!--more--> marker text in output', () => {
    const text = generateExcerpt('hello<!--more-->world');
    expect(text).not.toContain('more');
  });
});

// ---------------------------------------------------------------------------
// XSS prevention in renderContentExcerpt (security fix)
// ---------------------------------------------------------------------------
describe('renderContentExcerpt XSS prevention', () => {
  it('escapes double quotes in permalink attribute', () => {
    const html = renderContentExcerpt(
      'intro<!--more-->rest',
      '阅读更多',
      '/post/" onmouseover="alert(1)',
    );
    // The double quotes should be escaped as &quot; preventing attribute breakout
    expect(html).toContain('&quot;');
    // The href value should be safely escaped, not creating a real onmouseover attribute
    expect(html).not.toMatch(/onmouseover="alert/);
    // The escaped version is safe: it's inside the href attribute value
    expect(html).toContain('href="/post/&quot; onmouseover=&quot;alert(1)"');
  });

  it('escapes HTML tags in moreText', () => {
    const html = renderContentExcerpt(
      'intro<!--more-->rest',
      '<script>alert("xss")</script>',
      '/post/1/',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes & in permalink', () => {
    const html = renderContentExcerpt(
      'intro<!--more-->rest',
      'more',
      '/post?a=1&b=2',
    );
    expect(html).toContain('&amp;');
  });

  it('normal permalink and moreText render correctly', () => {
    const html = renderContentExcerpt(
      'intro<!--more-->rest',
      '继续阅读',
      '/archives/1/',
    );
    expect(html).toContain('href="/archives/1/"');
    expect(html).toContain('继续阅读');
    expect(html).toContain('class="more"');
  });
});

// ---------------------------------------------------------------------------
// iframe sanitization (domain restriction fix)
// ---------------------------------------------------------------------------
describe('renderMarkdown iframe filtering', () => {
  it('allows YouTube iframes', () => {
    const md = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>';
    const html = renderMarkdown(md);
    expect(html).toContain('iframe');
    expect(html).toContain('youtube.com');
  });

  it('allows Bilibili iframes', () => {
    const md = '<iframe src="https://player.bilibili.com/player.html?bvid=BV1xx411c7mD"></iframe>';
    const html = renderMarkdown(md);
    expect(html).toContain('iframe');
    expect(html).toContain('bilibili.com');
  });

  it('strips iframes from untrusted domains', () => {
    const md = '<iframe src="https://evil.com/steal"></iframe>';
    const html = renderMarkdown(md);
    // sanitize-html strips the src attribute from untrusted domains
    expect(html).not.toContain('evil.com');
    expect(html).not.toContain('src=');
  });

  it('strips iframes with javascript: URLs', () => {
    const md = '<iframe src="javascript:alert(1)"></iframe>';
    const html = renderMarkdown(md);
    expect(html).not.toContain('javascript:');
  });
});

describe('renderCommentText', () => {
  it('escapes HTML when no comment tags are allowed', () => {
    const html = renderCommentText('<strong>bold</strong><script>alert(1)</script>');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('bold');
  });

  it('allows configured comment tags and attributes', () => {
    const html = renderCommentText('<a href="https://example.com">site</a>', {
      htmlTagAllowed: '<a href="">',
    });
    expect(html).toContain('<a href="https://example.com">site</a>');
  });

  it('honors comment markdown setting', () => {
    const plain = renderCommentText('**bold**', { markdown: false });
    const markdown = renderCommentText('**bold**', { markdown: true });
    expect(plain).not.toContain('<strong>');
    expect(markdown).toContain('<strong>bold</strong>');
  });
});
