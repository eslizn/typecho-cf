/**
 * Content utility functions
 * Corresponds to Typecho's Widget/Base/Contents.php
 */
import { renderPermalinkPattern } from '@/lib/permalink-pattern';
import { DEFAULT_TIMEZONE, getTimezoneDateParts, type TimezoneSetting } from '@/lib/timezone';

/**
 * Generate a URL-safe slug from a string
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 150);
}

/**
 * Build a permalink for a content item
 * Supports dynamic permalink patterns from options.permalinkPattern
 *
 * Pattern variables:
 *   {cid}      - Content ID
 *   {slug}     - URL slug
 *   {category} - Primary category slug
 *   {year}     - 4-digit year
 *   {month}    - 2-digit month
 *   {day}      - 2-digit day
 */
export function buildPermalink(
  content: {
    cid: number;
    slug: string | null;
    type: string | null;
    created: number | null;
    category?: string | null;
  },
  siteUrl: string,
  pattern?: string | null,
  pagePattern?: string | null,
  timezone: TimezoneSetting = 'UTC',
): string {
  const base = siteUrl.replace(/\/$/, '');

  // Pages use pagePattern (default: /{slug})
  if (content.type === 'page' || content.type === 'page_draft') {
    const pgPattern = pagePattern || '/{slug}';
    const url = renderPermalinkPattern(pgPattern, 'page', {
      cid: content.cid,
      slug: content.slug || String(content.cid),
    }) ?? `/${content.slug || content.cid}`;
    return `${base}${url}`;
  }

  // Attachments always use fixed pattern
  if (content.type === 'attachment') {
    return `${base}/attachment/${content.cid}/`;
  }

  // For posts, use the configured pattern (default: /archives/{cid}/)
  const postPattern = pattern || '/archives/{cid}/';

  // Build date parts in the configured site timezone so date-based permalink
  // patterns match the local publication date shown throughout the admin.
  // Patterns without date tokens (including the default one) skip the
  // timezone conversion entirely.
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  if (/\{(?:year|month|day)\}/.test(postPattern)) {
    const { parts } = getTimezoneDateParts(
      content.created || Math.floor(Date.now() / 1000),
      timezone,
    );
    year = String(parts.year);
    month = String(parts.month).padStart(2, '0');
    day = String(parts.day).padStart(2, '0');
  }

  const url = renderPermalinkPattern(postPattern, 'post', {
    cid: content.cid,
    slug: content.slug || String(content.cid),
    category: content.category || 'uncategorized',
    year,
    month,
    day,
  }) ?? `/archives/${content.cid}/`;

  return `${base}${url}`;
}

function normalizePathForRedirect(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
}

/**
 * Return a safe redirect target only when it differs from the current URL.
 * This prevents route handlers from issuing a 302 to the same canonical path.
 */
export function getRedirectPathIfDifferent(currentUrl: string, targetUrl: string): string | null {
  const current = new URL(currentUrl, 'http://typecho-cf.local');
  const target = new URL(targetUrl, current.origin);

  const currentPath = normalizePathForRedirect(current.pathname);
  const targetPath = normalizePathForRedirect(target.pathname);

  if (currentPath === targetPath && current.search === target.search) {
    return null;
  }

  return `${target.pathname}${target.search}${target.hash}`;
}

/**
 * Build category permalink
 * Supports custom category path patterns.
 * Pattern variables:
 *   {slug}     - Category slug
 *   {mid}      - Category ID
 */
export function buildCategoryLink(
  slug: string,
  siteUrl: string,
  categoryPattern?: string | null,
  mid?: number | null,
): string {
  const base = siteUrl.replace(/\/$/, '');
  const pattern = categoryPattern || '/category/{slug}/';
  const url = renderPermalinkPattern(pattern, 'category', { slug, mid })
    ?? `/category/${slug}/`;
  return `${base}${url}`;
}

/**
 * Build tag permalink
 */
export function buildTagLink(slug: string, siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, '')}/tag/${slug}/`;
}

/**
 * Build author permalink
 */
export function buildAuthorLink(uid: number, siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, '')}/author/${uid}/`;
}

/**
 * Build date archive permalink
 */
export function buildDateLink(
  year: number,
  month?: number,
  day?: number,
  siteUrl = ''
): string {
  const base = siteUrl.replace(/\/$/, '');
  const yearPart = String(year).padStart(4, '0');
  if (day && month) {
    return `${base}/${yearPart}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/`;
  }
  if (month) {
    return `${base}/${yearPart}/${String(month).padStart(2, '0')}/`;
  }
  return `${base}/${yearPart}/`;
}

/**
 * Build search permalink
 */
export function buildSearchLink(keywords: string, siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, '')}/search/${encodeURIComponent(keywords)}/`;
}

/** Month-name formatters are reused across list rows; keep the cache bounded. */
const MONTH_FORMATTER_CACHE_LIMIT = 32;
const monthFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getMonthFormatter(
  locale: string,
  timezone: string,
  month: 'long' | 'short',
): Intl.DateTimeFormat {
  const key = `${locale}\u0000${timezone}\u0000${month}`;
  const cached = monthFormatterCache.get(key);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, { month, timeZone: timezone, calendar: 'gregory' });
  } catch {
    formatter = new Intl.DateTimeFormat('en', { month, timeZone: timezone, calendar: 'gregory' });
  }
  if (monthFormatterCache.size >= MONTH_FORMATTER_CACHE_LIMIT) {
    const oldest = monthFormatterCache.keys().next().value;
    if (oldest !== undefined) monthFormatterCache.delete(oldest);
  }
  monthFormatterCache.set(key, formatter);
  return formatter;
}

/**
 * Format a Unix timestamp using PHP-style date formatting
 * Supports common PHP date format characters. The timezone uses an IANA
 * identifier with regional DST rules.
 */
export function formatDate(
  timestamp: number,
  format: string,
  timezone: TimezoneSetting = DEFAULT_TIMEZONE,
  locale = 'en',
): string {
  const date = new Date(Math.trunc(timestamp) * 1000);
  const { parts, formatTimezone } = getTimezoneDateParts(timestamp, timezone);

  const Y = String(parts.year);
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const H = String(parts.hour).padStart(2, '0');
  const i = String(parts.minute).padStart(2, '0');
  const s = String(parts.second).padStart(2, '0');
  const n = String(parts.month);
  const j = String(parts.day);
  const c = new Date(timestamp * 1000).toISOString();

  // For UTC, use a synthetic UTC date matching the local calendar fields. For
  // an IANA zone, format the original instant in that zone so month names
  // follow DST-aware local date boundaries.
  const monthDate = formatTimezone === 'UTC'
    ? new Date(Date.UTC(parts.year, parts.month - 1, 1))
    : date;
  let F: string | undefined;
  let M: string | undefined;

  const replacements: Record<string, string> = { Y, m, d, H, i, s, n, j, c };

  // Single-pass replacement: match either an escaped char (\X) or a format letter (X).
  // This prevents substituted values from being re-processed by subsequent replacements.
  // Month-name formatters are only created when F/M actually appears.
  return format.replace(/\\(.)|(Y|m|d|H|i|s|n|j|F|M|c)/g, (match, escaped, token) => {
    if (escaped !== undefined) {
      // \X — output the literal character X (strips the backslash)
      return escaped;
    }
    if (token === 'F') {
      F ??= getMonthFormatter(locale, formatTimezone, 'long').format(monthDate);
      return F;
    }
    if (token === 'M') {
      M ??= getMonthFormatter(locale, formatTimezone, 'short').format(monthDate);
      return M;
    }
    return replacements[token] ?? match;
  });
}

/**
 * Calculate reading time in minutes
 */
export function calculateReadingTime(text: string): number {
  const wordCount = text.replace(/<[^>]+>/g, '').length;
  // Assume ~500 chars/min for Chinese, ~200 words/min for English
  return Math.max(1, Math.ceil(wordCount / 500));
}

/**
 * Parse content type from the `type` field
 */
export function getContentType(type: string | null): 'post' | 'page' | 'attachment' | 'draft' {
  if (!type) return 'post';
  if (type.endsWith('_draft')) return 'draft';
  if (type === 'page') return 'page';
  if (type === 'attachment') return 'attachment';
  return 'post';
}
