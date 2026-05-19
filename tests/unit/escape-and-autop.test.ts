/**
 * Unit tests for src/lib/escape.ts (G3-3) and the rebuilt autop (G3-4)
 * + the strict comment HTML allowlist (G3-1).
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeXml, escapeCData, escapeAttr } from '@/lib/escape';
import { autop, renderCommentText } from '@/lib/markdown';

describe('escape helpers (G3-3)', () => {
  it('escapeHtml encodes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&"</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&quot;&lt;/a&gt;');
  });

  it('escapeXml uses &apos; (legal in XML, where escapeHtml uses &#39;)', () => {
    expect(escapeXml(`a'b`)).toBe('a&apos;b');
    expect(escapeHtml(`a'b`)).toBe('a&#39;b');
  });

  it('escapeCData defuses ]]> sequences', () => {
    expect(escapeCData('a]]>b')).toBe('a]]]]><![CDATA[>b');
  });

  it('escapeAttr leaves > unencoded by spec but escapes & < "', () => {
    expect(escapeAttr('"&<>')).toBe('&quot;&amp;&lt;&gt;');
  });
});

describe('autop block-level detection (G3-4)', () => {
  it('wraps plain paragraphs in <p>', () => {
    expect(autop('hello\n\nworld')).toBe('<p>hello</p>\n<p>world</p>');
  });

  it('does not double-wrap an existing <p> block', () => {
    const input = '<p>already wrapped</p>\n\nplain';
    const out = autop(input);
    expect(out).toBe('<p>already wrapped</p>\n<p>plain</p>');
    // Critically, no <p><p>...</p></p>.
    expect(out).not.toContain('<p><p>');
  });

  it('leaves block-level elements alone', () => {
    expect(autop('<blockquote>q</blockquote>\n\nplain')).toBe('<blockquote>q</blockquote>\n<p>plain</p>');
    expect(autop('<ul>\n<li>x</li>\n</ul>')).toBe('<ul>\n<li>x</li>\n</ul>');
    expect(autop('<h1>Title</h1>\n\nbody')).toBe('<h1>Title</h1>\n<p>body</p>');
  });

  it('converts single newlines inside a paragraph to <br />', () => {
    expect(autop('line1\nline2')).toBe('<p>line1<br />line2</p>');
  });

  it('handles empty input', () => {
    expect(autop('')).toBe('');
    expect(autop('\n\n\n')).toBe('');
  });
});

describe('comment HTML allowlist denies unsafe attributes (G3-1)', () => {
  // Custom administrator-defined allowlist that, naïvely parsed, would
  // re-enable XSS surface by passing onerror/onclick/style straight
  // through to sanitize-html.
  const malicious = '<a href onclick><img src onerror><div style>';

  it('strips on*-prefixed attributes regardless of allowlist intent', () => {
    const out = renderCommentText('<a href="https://x" onclick="alert(1)">click</a>', {
      htmlTagAllowed: malicious,
    });
    expect(out).not.toContain('onclick');
  });

  it('strips style attributes', () => {
    const out = renderCommentText('<div style="color:red">x</div>', {
      htmlTagAllowed: malicious,
    });
    expect(out).not.toContain('style');
  });

  it('strips img onerror', () => {
    const out = renderCommentText('<img src="x" onerror="alert(1)" />', {
      htmlTagAllowed: malicious,
    });
    expect(out).not.toContain('onerror');
  });

  it('still keeps legitimate href on <a>', () => {
    const out = renderCommentText('<a href="https://example.com">ok</a>', {
      htmlTagAllowed: '<a href>',
    });
    expect(out).toContain('href="https://example.com"');
  });
});
