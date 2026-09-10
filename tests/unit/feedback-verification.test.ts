/**
 * Guards for the pingback/trackback backlink check.
 */
import { describe, expect, it } from 'vitest';
import { isFetchableFeedbackSource, urlCandidates } from '@/lib/feedback-verification';

describe('isFetchableFeedbackSource', () => {
  it('accepts public http(s) hosts', () => {
    expect(isFetchableFeedbackSource('https://example.com/post')).toBe(true);
    expect(isFetchableFeedbackSource('http://example.com/post')).toBe(true);
  });

  it('refuses non-http schemes, loopback, private ranges, and internal names', () => {
    for (const url of [
      'ftp://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://0.0.0.0/x',
      'http://10.1.2.3/x',
      'http://172.16.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://db.internal/x',
      'http://printer.local/x',
    ]) {
      expect(isFetchableFeedbackSource(url), url).toBe(false);
    }
  });
});

describe('urlCandidates', () => {
  it('covers absolute, HTML-escaped, and site-relative spellings', () => {
    const candidates = urlCandidates('https://example.com/a?x=1&y=2', 'https://source.test/post');

    expect(candidates).toContain('https://example.com/a?x=1&y=2');
    expect(candidates).toContain('https://example.com/a?x=1&amp;y=2');
    expect(candidates).toContain('/a?x=1&y=2');
    expect(candidates).toContain('/a');
  });
});
