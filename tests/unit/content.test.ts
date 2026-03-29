/**
 * Unit tests for src/lib/content.ts
 *
 * Tests permalink building, date formatting, slug generation, and other
 * content utility functions.
 */
import { describe, it, expect } from 'vitest';
import {
  generateSlug,
  buildPermalink,
  buildCategoryLink,
  buildTagLink,
  buildAuthorLink,
  formatDate,
} from '@/lib/content';

// ---------------------------------------------------------------------------
// generateSlug
// ---------------------------------------------------------------------------
describe('generateSlug()', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(generateSlug('Hello World')).toBe('hello-world');
  });

  it('collapses multiple spaces/hyphens', () => {
    expect(generateSlug('Hello   World')).toBe('hello-world');
  });

  it('removes leading and trailing hyphens', () => {
    expect(generateSlug(' Hello World ')).toBe('hello-world');
  });

  it('preserves Chinese characters', () => {
    const slug = generateSlug('你好 World');
    expect(slug).toContain('你好');
    expect(slug).toContain('world');
  });

  it('truncates to 150 characters', () => {
    const long = 'a'.repeat(200);
    expect(generateSlug(long)).toHaveLength(150);
  });
});

// ---------------------------------------------------------------------------
// buildPermalink
// ---------------------------------------------------------------------------
describe('buildPermalink()', () => {
  const siteUrl = 'https://example.com';
  const now = Math.floor(new Date('2026-03-15T00:00:00Z').getTime() / 1000);

  it('uses default /archives/{cid}/ pattern for posts', () => {
    const url = buildPermalink({ cid: 1, slug: 'hello', type: 'post', created: now }, siteUrl);
    expect(url).toBe('https://example.com/archives/1/');
  });

  it('substitutes {slug} in post pattern', () => {
    const url = buildPermalink(
      { cid: 1, slug: 'hello-world', type: 'post', created: now },
      siteUrl,
      '/archives/{slug}.html',
    );
    expect(url).toBe('https://example.com/archives/hello-world.html');
  });

  it('substitutes date variables in post pattern', () => {
    const url = buildPermalink(
      { cid: 1, slug: 'post', type: 'post', created: now },
      siteUrl,
      '/{year}/{month}/{day}/{slug}.html',
    );
    expect(url).toBe('https://example.com/2026/03/15/post.html');
  });

  it('uses cid as fallback when slug is null', () => {
    const url = buildPermalink(
      { cid: 5, slug: null, type: 'post', created: now },
      siteUrl,
      '/archives/{slug}.html',
    );
    expect(url).toBe('https://example.com/archives/5.html');
  });

  it('uses /{slug}.html pattern for pages', () => {
    const url = buildPermalink({ cid: 2, slug: 'about', type: 'page', created: now }, siteUrl);
    expect(url).toBe('https://example.com/about.html');
  });

  it('respects custom page pattern', () => {
    const url = buildPermalink(
      { cid: 2, slug: 'about', type: 'page', created: now },
      siteUrl,
      null,
      '/{cid}/{slug}/',
    );
    expect(url).toBe('https://example.com/2/about/');
  });

  it('uses /attachment/{cid}/ for attachments', () => {
    const url = buildPermalink({ cid: 10, slug: 'file', type: 'attachment', created: now }, siteUrl);
    expect(url).toBe('https://example.com/attachment/10/');
  });

  it('strips trailing slash from siteUrl', () => {
    const url = buildPermalink(
      { cid: 1, slug: 'hello', type: 'post', created: now },
      'https://example.com/',
    );
    expect(url).toBe('https://example.com/archives/1/');
  });
});

// ---------------------------------------------------------------------------
// buildCategoryLink
// ---------------------------------------------------------------------------
describe('buildCategoryLink()', () => {
  it('uses default /category/{slug}/ pattern', () => {
    expect(buildCategoryLink('tech', 'https://example.com')).toBe('https://example.com/category/tech/');
  });

  it('respects custom category pattern', () => {
    expect(buildCategoryLink('tech', 'https://example.com', '/topics/{slug}/')).toBe(
      'https://example.com/topics/tech/',
    );
  });
});

// ---------------------------------------------------------------------------
// buildTagLink
// ---------------------------------------------------------------------------
describe('buildTagLink()', () => {
  it('builds tag URL', () => {
    expect(buildTagLink('javascript', 'https://example.com')).toBe('https://example.com/tag/javascript/');
  });
});

// ---------------------------------------------------------------------------
// buildAuthorLink
// ---------------------------------------------------------------------------
describe('buildAuthorLink()', () => {
  it('builds author URL by uid', () => {
    expect(buildAuthorLink(3, 'https://example.com')).toBe('https://example.com/author/3/');
  });
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------
describe('formatDate()', () => {
  // Unix timestamp for 2026-03-15 12:30:45 UTC
  const ts = Math.floor(new Date('2026-03-15T12:30:45Z').getTime() / 1000);

  it('formats Y-m-d correctly', () => {
    // timezone offset 0 = UTC
    expect(formatDate(ts, 'Y-m-d', 0)).toBe('2026-03-15');
  });

  it('formats Y-m-d H:i:s correctly', () => {
    expect(formatDate(ts, 'Y-m-d H:i:s', 0)).toBe('2026-03-15 12:30:45');
  });

  it('applies timezone offset correctly (UTC+8)', () => {
    // ts at UTC 12:30 → UTC+8 20:30
    const formatted = formatDate(ts, 'H:i', 28800);
    expect(formatted).toBe('20:30');
  });

  it('formats month name (F)', () => {
    expect(formatDate(ts, 'F', 0)).toBe('March');
  });

  it('formats short month name (M)', () => {
    expect(formatDate(ts, 'M', 0)).toBe('Mar');
  });

  it('escapes backslash-prefixed characters', () => {
    // \a\t in format should be literal "at"
    const result = formatDate(ts, 'Y-m-d \\a\\t H:i', 0);
    expect(result).toBe('2026-03-15 at 12:30');
  });
});
