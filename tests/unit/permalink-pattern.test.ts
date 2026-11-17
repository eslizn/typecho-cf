import { describe, expect, it } from 'vitest';
import {
  compilePermalinkPattern,
  decodePathnameForMatching,
  renderPermalinkPattern,
} from '@/lib/permalink-pattern';

describe('permalink pattern grammar', () => {
  it('round-trips a post pattern through the shared renderer and matcher', () => {
    const pattern = '/{year}/{month}/{slug}.html';
    const path = renderPermalinkPattern(pattern, 'post', {
      year: '2026',
      month: '07',
      slug: 'hello',
    });
    expect(path).toBe('/2026/07/hello.html');
    expect(path!.match(compilePermalinkPattern(pattern, 'post')!)?.groups).toMatchObject({
      year: '2026',
      month: '07',
      slug: 'hello',
    });
  });

  it('rejects variables that the selected route cannot render', () => {
    expect(renderPermalinkPattern('/{year}/{slug}/', 'page', { slug: 'about' })).toBeNull();
    expect(compilePermalinkPattern('/{year}/{slug}/', 'page')).toBeNull();
  });

  it('rejects patterns with no resolvable identity', () => {
    expect(compilePermalinkPattern('/{year}/{month}/', 'post')).toBeNull();
  });

  it('escapes literal regex metacharacters', () => {
    const regex = compilePermalinkPattern('/docs+/{slug}.html', 'page')!;
    expect(regex.test('/docs+/about.html')).toBe(true);
    expect(regex.test('/docss/about.html')).toBe(false);
  });

  it('matches Unicode slugs after decoding percent-encoded pathnames', () => {
    const regex = compilePermalinkPattern('/post/{slug}/', 'post')!;
    const encoded = `/post/${encodeURIComponent('中文-文章')}/`;
    // The raw pathname matches the pattern, but captures the encoded slug,
    // which would miss every Unicode row in the DB lookup.
    expect(encoded.match(regex)?.groups?.slug).toBe(encodeURIComponent('中文-文章'));
    const decoded = decodePathnameForMatching(encoded);
    expect(decoded).toBe('/post/中文-文章/');
    expect(decoded.match(regex)?.groups?.slug).toBe('中文-文章');
  });

  it('leaves malformed escapes and encoded separators untouched', () => {
    expect(decodePathnameForMatching('/bad/%E0%A4%A/')).toBe('/bad/%E0%A4%A/');
    // Decoding %2F would turn one requested segment into several and create
    // an alias for a canonical URL.
    expect(decodePathnameForMatching('/posts%2Fslug/')).toBe('/posts%2Fslug/');
    expect(decodePathnameForMatching('/a/%5Cb/')).toBe('/a/%5Cb/');
  });
});
