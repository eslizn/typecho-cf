/**
 * Edge cache utilities using Cloudflare Workers Cache API (caches.default).
 *
 * - No extra bindings or dependencies needed.
 * - Per-PoP cache: cache.delete() only clears the current edge node.
 * - Logged-in users bypass cache entirely (ensured in middleware).
 */

import { schema, type Database } from '@/db';

/** Internal namespace used for Cache API keys that are not real URLs */
const INTERNAL_ORIGIN = 'https://typecho-cf-internal';

/**
 * Purge a list of public URLs from the edge cache.
 * Safe to call with empty array — returns immediately.
 * Relative URLs are skipped gracefully (no-op).
 */
export async function purgeCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const cache = caches.default;
  await Promise.all(urls.map(async (url) => {
    try {
      // Only try to purge absolute URLs (skip relative paths)
      if (url.startsWith('http://') || url.startsWith('https://')) {
        await cache.delete(new Request(url));
      }
    } catch {
      // Silently ignore errors (e.g., invalid URLs)
    }
  }));
}

/**
 * Purge the cached site options.
 */
export async function purgeOptionsCache(): Promise<void> {
  const cache = caches.default;
  await cache.delete(new Request(`${INTERNAL_ORIGIN}/__options`));
}

export async function bumpCacheVersion(db: Database): Promise<void> {
  await db.insert(schema.options)
    .values({ name: 'cacheVersion', user: 0, value: String(Date.now()) })
    .onConflictDoUpdate({
      target: [schema.options.name, schema.options.user],
      set: { value: String(Date.now()) },
    });
  await purgeOptionsCache();
}

/**
 * Try to read cached options JSON.
 */
export async function getCachedOptions(): Promise<Record<string, unknown> | null> {
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
 * Cache API storage is per-isolate and not publicly accessible.
 */
export async function setCachedOptions(data: Record<string, unknown>): Promise<void> {
  const cache = caches.default;
  const res = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
    },
  });
  await cache.put(new Request(`${INTERNAL_ORIGIN}/__options`), res);
}

/**
 * Build a list of URLs that should be purged after a content write operation.
 * Covers index, feed, and the specific post page.
 */
export interface ContentPurgeUrlsOptions {
  contentUrl?: string | null;
  categoryUrls?: Array<string | null | undefined>;
  tagUrls?: Array<string | null | undefined>;
  authorUrl?: string | null;
}

export function buildContentPurgeUrls(
  siteUrl: string,
  cid?: number,
  related: ContentPurgeUrlsOptions = {},
): string[] {
  const base = siteUrl.replace(/\/$/, '');
  
  // Skip if siteUrl is empty or not an absolute URL (test environment)
  if (!base || !base.startsWith('http')) {
    return [];
  }
  
  const urls = [
    base + '/',
    base + '/feed',
    base + '/feed/atom',
    base + '/feed/rss',
    base + '/feed/comments',
    base + '/feed/rss/comments',
    base + '/feed/atom/comments',
  ];
  if (cid) {
    urls.push(base + `/archives/${cid}/`);
  }
  if (related.contentUrl) urls.push(related.contentUrl);
  if (related.authorUrl) urls.push(related.authorUrl);
  for (const url of related.categoryUrls || []) {
    if (url) urls.push(url);
  }
  for (const url of related.tagUrls || []) {
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

/**
 * Purge content-related cache entries (index + feeds + specific post).
 * Does NOT purge the options cache — use purgeSiteCache for settings changes.
 */
export async function purgeContentCache(
  siteUrl: string,
  cid?: number,
  related: ContentPurgeUrlsOptions = {},
): Promise<void> {
  await purgeCache(buildContentPurgeUrls(siteUrl, cid, related));
}

/**
 * Purge site-wide cache: index + all feeds + options.
 * Used when site settings, theme, or plugin change.
 */
export async function purgeSiteCache(siteUrl: string): Promise<void> {
  await Promise.all([
    purgeCache(buildContentPurgeUrls(siteUrl)),
    purgeOptionsCache(),
  ]);
}
