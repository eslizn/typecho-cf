/**
 * Edge cache utilities using Cloudflare Workers Cache API (caches.default).
 *
 * - No extra bindings or dependencies needed.
 * - Per-PoP cache: cache.delete() only clears the current edge node.
 * - Logged-in users bypass cache entirely (ensured in middleware).
 */

/** Internal namespace used for Cache API keys that are not real URLs */
const INTERNAL_ORIGIN = 'https://typecho-cf-internal';

/**
 * Purge a list of public URLs from the edge cache.
 * Safe to call with empty array — returns immediately.
 */
export async function purgeCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const cache = caches.default;
  await Promise.all(urls.map((url) => cache.delete(new Request(url))));
}

/**
 * Purge the cached site options.
 */
export async function purgeOptionsCache(): Promise<void> {
  const cache = caches.default;
  await cache.delete(new Request(`${INTERNAL_ORIGIN}/__options`));
}

/**
 * Try to read cached options JSON.
 */
export async function getCachedOptions(): Promise<Record<string, any> | null> {
  const cache = caches.default;
  const res = await cache.match(new Request(`${INTERNAL_ORIGIN}/__options`));
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Write options JSON to cache (TTL = 10 minutes).
 */
export async function setCachedOptions(data: Record<string, any>): Promise<void> {
  const cache = caches.default;
  const res = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600', // 10 min
    },
  });
  await cache.put(new Request(`${INTERNAL_ORIGIN}/__options`), res);
}

/**
 * Build a list of URLs that should be purged after a content write operation.
 * Covers index, feed, and the specific post page.
 */
export function buildContentPurgeUrls(siteUrl: string, cid?: number): string[] {
  const base = siteUrl.replace(/\/$/, '');
  const urls = [
    base + '/',                 // index
    base + '/feed',             // RSS
    base + '/feed/atom',
    base + '/feed/rss',
    base + '/feed/comments',
  ];
  if (cid) {
    urls.push(base + `/archives/${cid}/`);
  }
  return urls;
}

/**
 * Purge everything related to content changes (index + feeds + options + specific post).
 */
export async function purgeContentCache(siteUrl: string, cid?: number): Promise<void> {
  await Promise.all([
    purgeCache(buildContentPurgeUrls(siteUrl, cid)),
    purgeOptionsCache(),
  ]);
}

/**
 * Purge site-wide cache: index + all feeds.
 * Used when site settings, theme, or plugin change.
 */
export async function purgeSiteCache(siteUrl: string): Promise<void> {
  const base = siteUrl.replace(/\/$/, '');
  await Promise.all([
    purgeCache([
      base + '/',
      base + '/feed',
      base + '/feed/atom',
      base + '/feed/rss',
      base + '/feed/comments',
    ]),
    purgeOptionsCache(),
  ]);
}
