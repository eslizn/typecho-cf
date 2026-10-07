/**
 * Unit tests for the public-cache policy.
 */
import { describe, it, expect, vi } from 'vitest';
import { bumpCacheVersion, getCachedOptions, isCacheablePublicPath, normalizeCacheKeyUrl, peekCacheVersion, resetCacheVersionMemo, setCachedOptions } from '@/lib/cache';
import { setOption } from '@/lib/options';
import { createTestDb, disposeTestDb } from '../helpers';

describe('cache version memo concurrency', () => {
  it.each(['bump', 'options-batch'] as const)('does not let a slow pre-write read overwrite %s invalidation', async (action) => {
    const db = await createTestDb();
    const findFirst = db.query.options.findFirst.bind(db.query.options);
    let resume!: () => void;
    let read!: () => void;
    const started = new Promise<void>(resolve => { read = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(db.query.options, 'findFirst').mockImplementationOnce((async (...args: Parameters<typeof findFirst>) => {
      const row = await findFirst(...args);
      read();
      await gate;
      return row;
    }) as typeof db.query.options.findFirst);
    const pending = peekCacheVersion(db as any);
    await started;
    if (action === 'bump') await bumpCacheVersion(db as any);
    else await setOption(db as any, 'title', 'Updated');
    resume();
    try {
      expect(await pending).toBe('1');
      expect(await peekCacheVersion(db as any)).toBe('1');
    } finally {
      db.$client.close();
      await disposeTestDb(db);
      resetCacheVersionMemo();
    }
  });
});

describe('normalizeCacheKeyUrl()', () => {
  it('drops campaign noise and canonicalises parameter order', () => {
    const normalized = normalizeCacheKeyUrl('https://example.com/post?b=2&utm_source=news&a=1');
    expect(normalized.toString()).toBe('https://example.com/post?a=1&b=2');
  });
});

describe('cache backend failures', () => {
  it('treats a failed options lookup as a cache miss and a failed write as best-effort', async () => {
    const db = await createTestDb();
    const match = vi.spyOn(caches.default, 'match').mockRejectedValueOnce(new Error('cache unavailable'));
    const put = vi.spyOn(caches.default, 'put').mockRejectedValueOnce(new Error('cache unavailable'));
    try {
      await expect(getCachedOptions(db as any)).resolves.toBeNull();
      await expect(setCachedOptions({ title: 'Blog' }, '0')).resolves.toBeUndefined();
      expect(match).toHaveBeenCalledOnce();
      expect(put).toHaveBeenCalledOnce();
    } finally {
      match.mockRestore();
      put.mockRestore();
      db.$client.close();
      await disposeTestDb(db);
      resetCacheVersionMemo();
    }
  });
});

describe('isCacheablePublicPath()', () => {
  const defaults = {}; // every pattern falls back to its preset default

  it('caches the index', () => {
    expect(isCacheablePublicPath('/', defaults)).toBe(true);
  });

  it('caches default post/page/category permalink URLs', () => {
    expect(isCacheablePublicPath('/archives/123/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/archives/123', defaults)).toBe(true);
    expect(isCacheablePublicPath('/about', defaults)).toBe(true);
    expect(isCacheablePublicPath('/category/tech/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/category/tech', defaults)).toBe(true);
  });

  it('caches bare slugs under the default page pattern', () => {
    expect(isCacheablePublicPath('/about', defaults)).toBe(true);
    // /{slug} also covers dotted slugs; fixed single-segment surfaces stay out.
    expect(isCacheablePublicPath('/about.html', defaults)).toBe(true);
    expect(isCacheablePublicPath('/admin', defaults)).toBe(false);
  });

  it('caches tag/author/search archives (incl. pagination-normalized paths)', () => {
    expect(isCacheablePublicPath('/tag/tech/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/author/1/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/search/hello', defaults)).toBe(true);
  });

  it('caches feeds, sitemap and robots', () => {
    expect(isCacheablePublicPath('/feed/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/feed/atom', defaults)).toBe(true);
    expect(isCacheablePublicPath('/feed/rss/comments', defaults)).toBe(true);
    expect(isCacheablePublicPath('/category/tech/feed.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/tag/tech/feed.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/author/1/feed.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/sitemap.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/sitemap/1.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/sitemap/invalid.xml', defaults)).toBe(false);
    expect(isCacheablePublicPath('/robots.txt', defaults)).toBe(true);
  });

  it('never caches admin/api/upload paths', () => {
    expect(isCacheablePublicPath('/admin/', defaults)).toBe(false);
    expect(isCacheablePublicPath('/admin/options-general', defaults)).toBe(false);
    expect(isCacheablePublicPath('/api/comment', defaults)).toBe(false);
    expect(isCacheablePublicPath('/usr/uploads/2026/08/a.png', defaults)).toBe(false);
  });

  it('follows custom post permalink patterns', () => {
    const opts = { permalinkPattern: '/posts/{slug}/' };
    expect(isCacheablePublicPath('/posts/hello/', opts)).toBe(true);
    expect(isCacheablePublicPath('/archives/123/', opts)).toBe(false);
  });

  it('follows custom page and category patterns', () => {
    const opts = { pagePattern: '/pages/{slug}/', categoryPattern: '/topics/{slug}/' };
    expect(isCacheablePublicPath('/pages/about/', opts)).toBe(true);
    expect(isCacheablePublicPath('/about', opts)).toBe(false);
    expect(isCacheablePublicPath('/topics/tech/', opts)).toBe(true);
    expect(isCacheablePublicPath('/category/tech/', opts)).toBe(false);
  });

  it('still guards admin paths under a pathological custom pattern', () => {
    const opts = { pagePattern: '/admin/{slug}/' };
    expect(isCacheablePublicPath('/admin/settings/', opts)).toBe(false);
  });
});
