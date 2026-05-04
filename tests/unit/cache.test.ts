/**
 * Unit tests for cache URL planning.
 */
import { describe, it, expect } from 'vitest';
import { buildContentPurgeUrls } from '@/lib/cache';

describe('buildContentPurgeUrls()', () => {
  it('includes custom permalink and related archive URLs', () => {
    const urls = buildContentPurgeUrls('https://example.com/', 42, {
      contentUrl: 'https://example.com/posts/hello/',
      categoryUrls: ['https://example.com/category/tech/'],
      tagUrls: ['https://example.com/tag/astro/'],
      authorUrl: 'https://example.com/author/1/',
    });

    expect(urls).toContain('https://example.com/');
    expect(urls).toContain('https://example.com/feed/rss/comments');
    expect(urls).toContain('https://example.com/archives/42/');
    expect(urls).toContain('https://example.com/posts/hello/');
    expect(urls).toContain('https://example.com/category/tech/');
    expect(urls).toContain('https://example.com/tag/astro/');
    expect(urls).toContain('https://example.com/author/1/');
  });

  it('deduplicates URLs', () => {
    const urls = buildContentPurgeUrls('https://example.com', 1, {
      contentUrl: 'https://example.com/archives/1/',
    });

    expect(urls.filter((url) => url === 'https://example.com/archives/1/')).toHaveLength(1);
  });
});
