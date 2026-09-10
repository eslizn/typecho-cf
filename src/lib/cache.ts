/**
 * Edge cache utilities using Cloudflare Workers Cache API (caches.default).
 *
 * - No extra bindings or dependencies needed.
 * - Per-PoP cache: cache.delete() only clears the current edge node.
 * - Logged-in users bypass cache entirely (ensured in middleware).
 *
 * Cross-PoP consistency for the options cache: the cache key embeds a
 * version stamp read from D1. bumpCacheVersion() advances the stamp so
 * every PoP naturally misses on its next read, no purge required.
 */

import { eq, and, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { OPTIONS_CACHE_TTL_SECONDS } from '@/lib/constants';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { compilePermalinkPattern, DEFAULT_PERMALINK_PATTERNS } from '@/lib/permalink-pattern';

/** Internal namespace used for Cache API keys that are not real URLs */
const INTERNAL_ORIGIN = 'https://typecho-cf-internal';

function optionsCacheKey(version: string | number): Request {
  return new Request(`${INTERNAL_ORIGIN}/__options?v=${encodeURIComponent(String(version))}`);
}

/**
 * Query parameters that must not fragment the public cache key: campaign and
 * click-id noise would otherwise create an unbounded number of Cache API
 * entries for the same page.
 */
const CACHE_KEY_IGNORED_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid', 'yclid', 'igshid', 'spm',
];

/**
 * Canonicalise a request URL for use as a public cache key: drop campaign
 * noise and sort the remaining parameters so `?a=1&b=2` and `?b=2&a=1` share
 * a single entry.
 */
export function normalizeCacheKeyUrl(requestUrl: string): URL {
  const url = new URL(requestUrl);
  for (const param of CACHE_KEY_IGNORED_PARAMS) url.searchParams.delete(param);
  url.searchParams.sort();
  return url;
}

// In-memory cache-version memo (per isolate). Cross-PoP invalidation of
// the options blob is bounded by CACHE_VERSION_MEMO_TTL_MS: a bump made
// on PoP-A takes at most this long to be seen on PoP-B. In exchange we
// avoid a D1 read on every loadOptions() call — worth the small
// staleness for read-heavy endpoints.
const CACHE_VERSION_MEMO_TTL_MS = 60_000;
let cachedVersion: string | null = null;
let cachedVersionAt = 0;

async function readCacheVersion(db: Database, now = Date.now()): Promise<string> {
  if (cachedVersion !== null && now - cachedVersionAt < CACHE_VERSION_MEMO_TTL_MS) {
    return cachedVersion;
  }
  const row = await db.query.options.findFirst({
    where: and(eq(schema.options.name, 'cacheVersion'), eq(schema.options.user, 0)),
  });
  cachedVersion = row?.value ?? '0';
  cachedVersionAt = now;
  return cachedVersion;
}

/**
 * Cheap cacheVersion probe used by loadOptions to invalidate the isolate
 * options snapshot after a cross-PoP bump (bounded by the memo TTL).
 */
export async function peekCacheVersion(db: Database): Promise<string> {
  return readCacheVersion(db);
}

/** Test-only: reset the in-memory version memo so unit tests start fresh. */
export function resetCacheVersionMemo(): void {
  cachedVersion = null;
  cachedVersionAt = 0;
}

/**
 * Decide whether a front-end path is eligible for the public edge cache.
 *
 * The cacheable URL space is derived from the admin permalink settings
 * (post / page / category patterns) plus the fixed public archive surfaces
 * (index, tag, author, search, feeds, sitemap, robots). The caller passes
 * the pagination-normalized effective path (/page/N/ is already stripped).
 * Admin, API and upload paths are never eligible even if a custom pattern
 * would match them (defense in depth against pathological patterns).
 */
export function isCacheablePublicPath(
  path: string,
  options: {
    permalinkPattern?: string | null;
    pagePattern?: string | null;
    categoryPattern?: string | null;
  },
): boolean {
  // Hard guard: admin/API/uploads are never cached.
  if (path.startsWith('/admin') || path.startsWith('/api/') || path.startsWith('/usr/')) return false;

  // Index (including /page/N/ which the middleware normalizes to '/').
  if (path === '/') return true;

  // Content URLs derived from the configured permalink patterns. Defaults
  // mirror options-input.ts so a fresh install behaves like the presets.
  const postPattern = compilePermalinkPattern(options.permalinkPattern ?? DEFAULT_PERMALINK_PATTERNS.post, 'post');
  const pagePattern = compilePermalinkPattern(options.pagePattern ?? DEFAULT_PERMALINK_PATTERNS.page, 'page');
  const categoryPattern = compilePermalinkPattern(options.categoryPattern ?? DEFAULT_PERMALINK_PATTERNS.category, 'category');
  if (postPattern?.test(path) || pagePattern?.test(path) || categoryPattern?.test(path)) return true;

  // Fixed public archive surfaces.
  if (path.startsWith('/tag/') || path.startsWith('/author/') || path.startsWith('/search/')) return true;
  if (path.startsWith('/feed') || path.endsWith('/feed.xml')) return true;
  if (path === '/sitemap.xml' || path === '/robots.txt') return true;

  return false;
}

export async function bumpCacheVersion(db: Database): Promise<void> {
  const [updated] = await db.insert(schema.options)
    .values({ name: 'cacheVersion', user: 0, value: '1' })
    .onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: {
        value: sql`cast(coalesce(${schema.options.value}, '0') as integer) + 1`,
      },
    })
    .returning({ value: schema.options.value });
  const stamp = updated?.value ?? '1';
  // Best-effort local memo update so the writer sees its own bump on
  // subsequent reads within the same isolate (other PoPs will refresh
  // after their memo expires — see CACHE_VERSION_MEMO_TTL_MS).
  cachedVersion = stamp;
  cachedVersionAt = Date.now();
  advanceOptionsSnapshotGeneration();
}

/**
 * Try to read cached options JSON, keyed by the current cacheVersion.
 * The version is memoized in-isolate for a short TTL so we don't hit D1
 * on every loadOptions() call. Cross-PoP writes become visible within
 * CACHE_VERSION_MEMO_TTL_MS.
 */
export async function getCachedOptions(db: Database): Promise<Record<string, unknown> | null> {
  const version = await readCacheVersion(db);
  const cache = caches.default;
  const res = await cache.match(optionsCacheKey(version));
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Write options JSON to cache under the current version stamp.
 * Callers must pass the version they read so a subsequent bump in
 * another PoP doesn't leave a stale entry under a fresh key.
 */
export async function setCachedOptions(data: Record<string, unknown>, version: string | number): Promise<void> {
  const cache = caches.default;
  const res = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${OPTIONS_CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(optionsCacheKey(version), res);
}

/**
 * Invalidate every cached public artifact (pages, feeds, options blob).
 *
 * Public cache keys embed `cacheVersion`, so advancing that stamp is the only
 * invalidation primitive this project needs — it works across PoPs without a
 * purge API. The previous URL-by-URL `purgeCache` / `purgeContentCache` /
 * `purgeSiteCache` helpers had degraded into no-ops and were removed so that
 * write paths have exactly one call to make.
 */
export async function invalidateSiteCache(db: Database): Promise<void> {
  await bumpCacheVersion(db);
}
