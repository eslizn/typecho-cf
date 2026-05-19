import { describe, expect, it } from 'vitest';
import { normalizeHttpUrl } from '@/lib/url';

describe('normalizeHttpUrl', () => {
  it('returns the URL string for valid http URLs', () => {
    const result = normalizeHttpUrl('http://example.com');
    expect(result).toBe('http://example.com/');
  });

  it('returns the URL string for valid https URLs', () => {
    const result = normalizeHttpUrl('https://example.com/path?q=1');
    expect(result).toBe('https://example.com/path?q=1');
  });

  it('rejects non-http protocols', () => {
    expect(normalizeHttpUrl('ftp://example.com')).toBeNull();
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('returns empty string for empty input', () => {
    expect(normalizeHttpUrl('')).toBe('');
    expect(normalizeHttpUrl('  ')).toBe('');
  });

  it('trims whitespace', () => {
    expect(normalizeHttpUrl('  https://example.com  ')).toBe('https://example.com/');
  });

  it('returns null for invalid URLs', () => {
    expect(normalizeHttpUrl('not a url')).toBeNull();
    expect(normalizeHttpUrl('http://')).toBeNull();
  });

  it('normalizes URLs with path segments', () => {
    expect(normalizeHttpUrl('https://example.com/a/b/c')).toBe('https://example.com/a/b/c');
  });
});
