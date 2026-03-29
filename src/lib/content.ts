/**
 * Content utility functions
 * Corresponds to Typecho's Widget/Base/Contents.php
 */

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
): string {
  const base = siteUrl.replace(/\/$/, '');

  // Pages use pagePattern (default: /{slug}.html)
  if (content.type === 'page' || content.type === 'page_draft') {
    const pgPattern = pagePattern || '/{slug}.html';
    const url = pgPattern
      .replace(/\{cid\}/g, String(content.cid))
      .replace(/\{slug\}/g, content.slug || String(content.cid));
    return `${base}${url}`;
  }

  // Attachments always use fixed pattern
  if (content.type === 'attachment') {
    return `${base}/attachment/${content.cid}/`;
  }

  // For posts, use the configured pattern (default: /archives/{cid}/)
  const postPattern = pattern || '/archives/{cid}/';

  // Build date parts from created timestamp
  const date = content.created ? new Date(content.created * 1000) : new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  const url = postPattern
    .replace(/\{cid\}/g, String(content.cid))
    .replace(/\{slug\}/g, content.slug || String(content.cid))
    .replace(/\{category\}/g, content.category || 'uncategorized')
    .replace(/\{year\}/g, year)
    .replace(/\{month\}/g, month)
    .replace(/\{day\}/g, day);

  return `${base}${url}`;
}

/**
 * Build category permalink
 * Supports custom category path patterns.
 * Pattern variables:
 *   {slug}     - Category slug
 *   {mid}      - Category ID
 */
export function buildCategoryLink(slug: string, siteUrl: string, categoryPattern?: string | null): string {
  const base = siteUrl.replace(/\/$/, '');
  const pattern = categoryPattern || '/category/{slug}/';
  const url = pattern
    .replace(/\{slug\}/g, slug)
    .replace(/\{mid\}/g, ''); // mid not commonly available in this context
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
  if (day && month) {
    return `${base}/${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/`;
  }
  if (month) {
    return `${base}/${year}/${String(month).padStart(2, '0')}/`;
  }
  return `${base}/${year}/`;
}

/**
 * Build search permalink
 */
export function buildSearchLink(keywords: string, siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, '')}/search/${encodeURIComponent(keywords)}/`;
}

/**
 * Format a Unix timestamp using PHP-style date formatting
 * Supports common PHP date format characters
 */
export function formatDate(timestamp: number, format: string, timezoneOffset = 28800): string {
  const date = new Date((timestamp + timezoneOffset) * 1000);
  const utcDate = new Date(date.getTime() + date.getTimezoneOffset() * 60000);

  const Y = String(utcDate.getFullYear());
  const m = String(utcDate.getMonth() + 1).padStart(2, '0');
  const d = String(utcDate.getDate()).padStart(2, '0');
  const H = String(utcDate.getHours()).padStart(2, '0');
  const i = String(utcDate.getMinutes()).padStart(2, '0');
  const s = String(utcDate.getSeconds()).padStart(2, '0');
  const n = String(utcDate.getMonth() + 1);
  const j = String(utcDate.getDate());
  const c = new Date(timestamp * 1000).toISOString();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const shortMonthNames = monthNames.map((name) => name.substring(0, 3));
  const F = monthNames[utcDate.getMonth()];
  const M = shortMonthNames[utcDate.getMonth()];

  const replacements: Record<string, string> = { Y, m, d, H, i, s, n, j, F, M, c };

  // Single-pass replacement: match either an escaped char (\X) or a format letter (X).
  // This prevents substituted values from being re-processed by subsequent replacements.
  return format.replace(/\\(.)|(Y|m|d|H|i|s|n|j|F|M|c)/g, (match, escaped, token) => {
    if (escaped !== undefined) {
      // \X — output the literal character X (strips the backslash)
      return escaped;
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
