import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { generateRandomString } from '@/lib/auth';
import {
  getCachedOptions,
  setCachedOptions,
  resetCacheVersionMemo,
  peekCacheVersion,
} from '@/lib/cache';
import {
  advanceOptionsSnapshotGeneration,
  getOptionsSnapshotGeneration,
} from '@/lib/options-snapshot-generation';
import { DEFAULT_TIMEZONE, isIanaTimezone, type TimezoneSetting } from '@/lib/timezone';

export interface SiteOptions {
  theme: string;
  /** IANA time zone identifier. */
  timezone: TimezoneSetting;
  lang: string;
  charset: string;
  contentType: string;
  title: string;
  description: string;
  keywords: string;
  siteUrl: string;
  frontPage: string;
  frontArchive: number;
  pageSize: number;
  postsListSize: number;
  commentsListSize: number;
  postDateFormat: string;
  commentDateFormat: string;
  defaultCategory: number;
  allowRegister: number;
  defaultAllowComment: number;
  defaultAllowPing: number;
  defaultAllowFeed: number;
  feedFullText: number;
  markdown: number;
  commentsRequireMail: number;
  commentsRequireURL: number;
  commentsRequireModeration: number;
  commentsWhitelist: number;
  commentsMaxNestingLevels: number;
  commentsPostTimeout: number;
  commentsUrlNofollow: number;
  commentsShowUrl: number;
  commentsMarkdown: number;
  commentsPageBreak: number;
  commentsThreaded: number;
  commentsPageSize: number;
  commentsPageDisplay: string;
  commentsOrder: string;
  commentsCheckReferer: number;
  commentsAutoClose: number;
  commentsPostIntervalEnable: number;
  commentsPostInterval: number;
  commentsShowCommentOnly: number;
  commentsAvatar: number;
  commentsAvatarRating: string;
  commentsAntiSpam: number;
  commentsHTMLTagAllowed: string | null;
  attachmentTypes: string;
  secret: string;
  installed: number;
  editorSize: number;
  autoSave: number;
  cacheEnabled: number;
  cacheVersion: number;
  activatedPlugins: string;
  permalinkPattern: string;
  pagePattern: string;
  categoryPattern: string;
  loginFailBanEnabled: number;
  loginFailBanWindowSeconds: number;
  loginFailBanMaxFailures: number;
  loginFailBanSeconds: number;
  feedItems: number;
  [key: string]: string | number | null | undefined;
}

const defaultOptions: Partial<SiteOptions> = {
  theme: 'typecho-theme-minimal',
  timezone: DEFAULT_TIMEZONE,
  lang: 'zh_CN',
  charset: 'UTF-8',
  contentType: 'text/html',
  title: 'Hello World',
  description: 'Your description here.',
  keywords: 'typecho,blog',
  frontPage: 'recent',
  frontArchive: 0,
  pageSize: 5,
  postsListSize: 10,
  commentsListSize: 10,
  postDateFormat: 'Y-m-d',
  commentDateFormat: 'F jS, Y',
  defaultCategory: 1,
  allowRegister: 0,
  defaultAllowComment: 1,
  defaultAllowPing: 1,
  defaultAllowFeed: 1,
  feedFullText: 1,
  markdown: 1,
  commentsRequireMail: 1,
  commentsRequireURL: 0,
  commentsRequireModeration: 0,
  commentsWhitelist: 0,
  commentsMaxNestingLevels: 5,
  commentsPostTimeout: 24 * 3600 * 30,
  commentsUrlNofollow: 1,
  commentsShowUrl: 1,
  commentsMarkdown: 0,
  commentsPageBreak: 0,
  commentsThreaded: 1,
  commentsPageSize: 20,
  commentsPageDisplay: 'last',
  commentsOrder: 'ASC',
  commentsCheckReferer: 1,
  commentsAutoClose: 0,
  commentsPostIntervalEnable: 1,
  commentsPostInterval: 60,
  commentsShowCommentOnly: 0,
  commentsAvatar: 1,
  commentsAvatarRating: 'G',
  commentsAntiSpam: 1,
  commentsHTMLTagAllowed: null,
  attachmentTypes: '@image@',
  cacheEnabled: 1,
  cacheVersion: 0,
  installed: 0,
  editorSize: 350,
  autoSave: 0,
  loginFailBanEnabled: 1,
  loginFailBanWindowSeconds: 300,
  loginFailBanMaxFailures: 5,
  loginFailBanSeconds: 900,
  feedItems: 10,
};

// Site options change rarely. Local writes invalidate this snapshot
// immediately; cross-PoP writes become visible once peekCacheVersion
// observes the bumped stamp (memo TTL ~60s), even while the parsed
// snapshot TTL is longer.
// Isolate-level (not WeakMap-by-db): getDb() builds a fresh Sessions handle
// per request, so a Database-keyed WeakMap never hits across requests.
const OPTIONS_SNAPSHOT_TTL_MS = 300_000;
type OptionsSnapshot = {
  value: SiteOptions;
  expiresAt: number;
  generation: number;
  /** Stamp observed when the snapshot was built — must match peekCacheVersion. */
  cacheVersion: string;
};
type PendingOptionsLoad = { promise: Promise<SiteOptions>; generation: number };
let optionSnapshot: OptionsSnapshot | null = null;
let pendingOptionLoad: PendingOptionsLoad | null = null;

function invalidateOptionsSnapshot(): void {
  advanceOptionsSnapshotGeneration();
  optionSnapshot = null;
  pendingOptionLoad = null;
}

/** Test-only: drop the isolate options snapshot. */
export function resetOptionsSnapshot(): void {
  optionSnapshot = null;
  pendingOptionLoad = null;
}

async function executeOptionBatch(db: Database, statements: any[]): Promise<void> {
  if (typeof (db as any).batch === 'function') {
    await (db as any).batch(statements);
    return;
  }
  // Lightweight plugin adapters and unit-test doubles may implement only
  // Drizzle statements. Production D1 always takes the single-round-trip path.
  for (const statement of statements) await statement;
}

function cacheVersionUpsert(db: Database) {
  return db
    .insert(schema.options)
    .values({ name: 'cacheVersion', user: 0, value: '1' })
    .onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: {
        value: sql`cast(coalesce(${schema.options.value}, '0') as integer) + 1`,
      },
    });
}

/**
 * Load all global options from database (with Cache API caching).
 *
 * This is a pure loader — it never mutates the row set. Call
 * `ensureSecret()` once at install time (or during migration) to
 * bootstrap the `secret` option. A missing secret here surfaces as
 * `opts.secret === undefined` so downstream code can fail fast rather
 * than picking up a race-generated value that varies between requests.
 */
export async function loadOptions(db: Database): Promise<SiteOptions> {
  const now = Date.now();
  const generation = getOptionsSnapshotGeneration();
  // Cross-PoP writes bump cacheVersion in D1. The memo bound is ~60s, so a
  // remote plugin activation / options change is visible here within that
  // window even when the parsed snapshot TTL is longer.
  const currentVersion = await peekCacheVersion(db);
  if (
    optionSnapshot &&
    optionSnapshot.generation === generation &&
    optionSnapshot.expiresAt > now &&
    optionSnapshot.cacheVersion === currentVersion
  ) {
    return { ...optionSnapshot.value };
  }

  if (
    optionSnapshot &&
    optionSnapshot.cacheVersion !== currentVersion
  ) {
    // Stamp moved (local or remote) — drop the stale parsed snapshot.
    optionSnapshot = null;
    pendingOptionLoad = null;
  }

  if (pendingOptionLoad?.generation === generation) {
    return { ...await pendingOptionLoad.promise };
  }

  const pending = loadOptionsFresh(db);
  const pendingRecord = { promise: pending, generation };
  pendingOptionLoad = pendingRecord;
  try {
    const value = await pending;
    if (getOptionsSnapshotGeneration() === generation) {
      optionSnapshot = {
        value,
        expiresAt: Date.now() + OPTIONS_SNAPSHOT_TTL_MS,
        generation,
        cacheVersion: currentVersion,
      };
    }
    return { ...value };
  } finally {
    if (pendingOptionLoad === pendingRecord) {
      pendingOptionLoad = null;
    }
  }
}

async function loadOptionsFresh(db: Database): Promise<SiteOptions> {
  // Try cache first — key is versioned by cacheVersion so cross-PoP
  // writes automatically bust the entry (one D1 read is much cheaper
  // than reloading all rows).
  const cached = await getCachedOptions(db);
  if (cached) {
    return normalizeOptions(cached);
  }

  const rows = await db
    .select()
    .from(schema.options)
    .where(eq(schema.options.user, 0));

  const opts: Record<string, string | number | null | undefined> = { ...defaultOptions };
  for (const row of rows) {
    opts[row.name] = row.value;
  }

  // Parse numeric values
  const numericKeys = [
    'frontArchive', 'pageSize', 'postsListSize',
    'commentsListSize', 'defaultCategory', 'allowRegister', 'defaultAllowComment',
    'defaultAllowPing', 'defaultAllowFeed', 'feedFullText', 'markdown',
    'commentsRequireMail', 'commentsRequireURL', 'commentsRequireModeration',
    'commentsWhitelist', 'commentsMaxNestingLevels', 'commentsPostTimeout',
    'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
    'commentsPageBreak', 'commentsThreaded', 'commentsPageSize',
    'commentsCheckReferer', 'commentsAutoClose', 'commentsPostIntervalEnable',
    'commentsPostInterval', 'commentsShowCommentOnly', 'commentsAvatar',
    'commentsAntiSpam', 'installed', 'editorSize', 'autoSave',
    'gzip', 'cacheEnabled', 'cacheVersion',
    'loginFailBanEnabled', 'loginFailBanWindowSeconds',
    'loginFailBanMaxFailures', 'loginFailBanSeconds',
    'feedItems',
  ];

  for (const key of numericKeys) {
    if (typeof opts[key] === 'string') {
      opts[key] = parseInt(opts[key] as string, 10) || 0;
    }
  }

  const normalizedOptions = normalizeOptions(opts);

  // Write to cache for subsequent requests, keyed by the version stamp
  // present at read time.
  await setCachedOptions(normalizedOptions, normalizedOptions.cacheVersion ?? 0);

  return normalizedOptions;
}

/** Normalize option rows to the current runtime representation. */
function normalizeOptions(options: Record<string, unknown>): SiteOptions {
  const normalized = { ...options };
  if (normalized.lang === null || normalized.lang === undefined) normalized.lang = 'zh_CN';
  const timezone = normalized.timezone;
  if (typeof timezone !== 'string' || !isIanaTimezone(timezone)) {
    normalized.timezone = DEFAULT_TIMEZONE;
  }
  return normalized as SiteOptions;
}

/**
 * Ensure the site has a `secret` option, generating one if missing. Kept
 * out of loadOptions() so the read path stays free of writes — otherwise
 * the very first request on a legacy PHP-Typecho migration would race
 * multiple isolates each generating a different secret.
 *
 * Callers: install flow (on fresh setup) and a one-shot migration path
 * for imported PHP databases where the secret used to live in
 * config.inc.php.
 */
export async function ensureSecret(db: Database): Promise<string> {
  const existing = await getOption(db, 'secret');
  if (existing) return existing;
  const secret = generateRandomString(32);
  await setOption(db, 'secret', secret);
  return secret;
}

/**
 * Get a single option value
 */
export async function getOption(db: Database, name: string, userId = 0): Promise<string | null> {
  const row = await db.query.options.findFirst({
    where: and(eq(schema.options.name, name), eq(schema.options.user, userId)),
  });
  return row?.value ?? null;
}

/**
 * Set an option value. Bumps the shared cacheVersion so every PoP's
 * options-cache read on the next request misses (via the versioned
 * cache key in cache.ts) — this is the only cross-PoP-safe invalidation
 * primitive we have.
 *
 * The bump happens BEFORE the write to close a race where a concurrent
 * read could still hit the pre-bump cache key: readers on the next
 * request see the new cacheVersion, miss the cache, and reload from D1.
 */
export async function setOption(db: Database, name: string, value: string, userId = 0): Promise<void> {
  const write = db
    .insert(schema.options)
    .values({ name, user: userId, value })
    .onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: { value },
    });
  if (name === 'cacheVersion') {
    await write;
  } else {
    await executeOptionBatch(db, [
      write,
      cacheVersionUpsert(db),
    ]);
    resetCacheVersionMemo();
  }
  invalidateOptionsSnapshot();
}

/**
 * Delete an option. Bumps cacheVersion — see setOption().
 */
export async function deleteOption(db: Database, name: string, userId = 0): Promise<void> {
  const remove = db
    .delete(schema.options)
    .where(and(eq(schema.options.name, name), eq(schema.options.user, userId)));
  if (name === 'cacheVersion') {
    await remove;
  } else {
    await executeOptionBatch(db, [
      remove,
      cacheVersionUpsert(db),
    ]);
    resetCacheVersionMemo();
  }
  invalidateOptionsSnapshot();
}

/**
 * Write many options in one batch and bump cacheVersion exactly once at
 * the end. Prefer this over a loop of `setOption()` calls whenever the
 * updates are semantically one atomic change (install, admin bulk save)
 * — it halves D1 writes because the per-key cacheVersion bumps are
 * collapsed into a single bump.
 *
 * Any entry named `cacheVersion` is applied but never triggers a
 * secondary bump (would recurse).
 */
export async function setOptionsBatch(
  db: Database,
  entries: Record<string, string>,
  userId = 0,
): Promise<void> {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;
  const statements = keys.map((name) =>
    db
      .insert(schema.options)
      .values({ name, user: userId, value: entries[name] })
      .onConflictDoUpdate({
        target: [schema.options.user, schema.options.name],
        set: { value: entries[name] },
      })
  );
  statements.push(cacheVersionUpsert(db));
  await executeOptionBatch(db, statements);
  // The batch wrote a new version without going through bumpCacheVersion().
  // Force the next local read to observe it instead of serving the old memo.
  resetCacheVersionMemo();
  invalidateOptionsSnapshot();
}

/**
 * Compute derived URLs from options
 */
export function computeUrls(opts: SiteOptions) {
  const siteUrl = opts.siteUrl?.replace(/\/$/, '') || '';
  return {
    siteUrl,
    adminUrl: `${siteUrl}/admin/`,
    loginUrl: `${siteUrl}/admin/login`,
    logoutUrl: `${siteUrl}/api/users/logout`,
    profileUrl: `${siteUrl}/admin/profile`,
    feedUrl: `${siteUrl}/feed`,
    feedRssUrl: `${siteUrl}/feed/rss`,
    feedAtomUrl: `${siteUrl}/feed/atom`,
    commentsFeedUrl: `${siteUrl}/feed/comments`,
    commentsFeedRssUrl: `${siteUrl}/feed/rss/comments`,
    commentsFeedAtomUrl: `${siteUrl}/feed/atom/comments`,
    themeUrl: (file: string) => `${siteUrl}/themes/${opts.theme}/${file}`,
  };
}
