/**
 * Unit tests for src/lib/content.ts
 *
 * Tests permalink building, date formatting, slug generation, and other
 * content utility functions.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  generateSlug,
  buildPermalink,
  buildCategoryLink,
  buildTagLink,
  buildAuthorLink,
  getRedirectPathIfDifferent,
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

  it('uses the default bare-slug pattern for pages', () => {
    const url = buildPermalink({ cid: 2, slug: 'about', type: 'page', created: now }, siteUrl);
    expect(url).toBe('https://example.com/about');
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
// getRedirectPathIfDifferent
// ---------------------------------------------------------------------------
describe('getRedirectPathIfDifferent()', () => {
  it('returns null for a redirect to the same path', () => {
    const target = getRedirectPathIfDifferent(
      'https://example.com/archives/2/',
      'https://example.com/archives/2/',
    );
    expect(target).toBeNull();
  });

  it('treats trailing slash differences as the same path', () => {
    const target = getRedirectPathIfDifferent(
      'https://example.com/archives/2',
      'https://example.com/archives/2/',
    );
    expect(target).toBeNull();
  });

  it('returns a relative redirect path when the target differs', () => {
    const target = getRedirectPathIfDifferent(
      'https://example.com/',
      'https://example.com/about',
    );
    expect(target).toBe('/about');
  });

  it('preserves query strings on real redirects', () => {
    const target = getRedirectPathIfDifferent(
      'https://example.com/',
      'https://example.com/search/?q=astro',
    );
    expect(target).toBe('/search/?q=astro');
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
    expect(formatDate(ts, 'Y-m-d', 'UTC')).toBe('2026-03-15');
  });

  it('formats Y-m-d H:i:s correctly', () => {
    expect(formatDate(ts, 'Y-m-d H:i:s', 'UTC')).toBe('2026-03-15 12:30:45');
  });

  it('applies an IANA timezone correctly (UTC+8)', () => {
    // ts at UTC 12:30 → UTC+8 20:30
    const formatted = formatDate(ts, 'H:i', 'Asia/Shanghai');
    expect(formatted).toBe('20:30');
  });

  it('formats IANA zones with daylight-saving rules', () => {
    const winter = Math.floor(new Date('2026-01-15T12:30:45Z').getTime() / 1000);
    const summer = Math.floor(new Date('2026-07-15T12:30:45Z').getTime() / 1000);
    expect(formatDate(winter, 'Y-m-d H:i', 'America/New_York')).toBe('2026-01-15 07:30');
    expect(formatDate(summer, 'Y-m-d H:i', 'America/New_York')).toBe('2026-07-15 08:30');
  });

  it('uses the configured Chinese IANA zone by default', () => {
    expect(formatDate(ts, 'Y-m-d H:i')).toBe('2026-03-15 20:30');
  });

  it('formats month name (F)', () => {
    expect(formatDate(ts, 'F', 'UTC')).toBe('March');
  });

  it('formats short month name (M)', () => {
    expect(formatDate(ts, 'M', 'UTC')).toBe('Mar');
  });

  it('escapes backslash-prefixed characters', () => {
    // \a\t in format should be literal "at"
    const result = formatDate(ts, 'Y-m-d \\a\\t H:i', 'UTC');
    expect(result).toBe('2026-03-15 at 12:30');
  });
});

// ---------------------------------------------------------------------------
// Intl formatter reuse (list rendering hot path)
// ---------------------------------------------------------------------------
describe('date formatter construction', () => {
  const ts = Math.floor(new Date('2026-03-15T12:30:45Z').getTime() / 1000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadContentWithCounter() {
    vi.resetModules();
    const Original = Intl.DateTimeFormat;
    let constructed = 0;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      constructed++;
      return new Original(...args);
    } as unknown as typeof Intl.DateTimeFormat);
    const content = await import('@/lib/content');
    return { content, count: () => constructed };
  }

  it('does not convert timezones for permalink patterns without date tokens', async () => {
    const { content, count } = await loadContentWithCounter();

    for (let cid = 1; cid <= 25; cid++) {
      expect(content.buildPermalink(
        { cid, slug: 'entry', type: 'post', created: ts },
        'https://example.com',
      )).toBe(`https://example.com/archives/${cid}/`);
    }

    expect(count()).toBe(0);
  });

  it('reuses the timezone formatter for date-based permalinks', async () => {
    const { content, count } = await loadContentWithCounter();

    for (let cid = 1; cid <= 25; cid++) {
      content.buildPermalink(
        { cid, slug: 'entry', type: 'post', created: ts },
        'https://example.com',
        '/{year}/{month}/{day}/{slug}/',
        undefined,
        'Asia/Shanghai',
      );
    }

    expect(count()).toBe(1);
  });

  it('does not build month-name formatters for numeric formats', async () => {
    const { content, count } = await loadContentWithCounter();

    for (let index = 0; index < 25; index++) {
      expect(content.formatDate(ts, 'Y-m-d H:i', 'Asia/Shanghai')).toBe('2026-03-15 20:30');
    }

    expect(count()).toBe(1);
  });

  it('reuses month-name formatters across calls', async () => {
    const { content, count } = await loadContentWithCounter();

    const first = content.formatDate(ts, 'F j, Y', 'Asia/Shanghai', 'zh-CN');
    const afterFirst = count();
    const second = content.formatDate(ts, 'F j, Y', 'Asia/Shanghai', 'zh-CN');

    expect(afterFirst).toBe(2);
    expect(second).toBe(first);
    expect(count()).toBe(afterFirst);
  });
});
