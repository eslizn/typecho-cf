import { compilePermalinkPattern, DEFAULT_PERMALINK_PATTERNS, type PermalinkPatternKind } from '@/lib/permalink-pattern';
import { normalizeLocale } from '@/lib/i18n';
import { isIanaTimezone } from '@/lib/timezone';

export class SiteOptionsInputError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'SiteOptionsInputError';
  }
}

const OPTION_KEYS = new Set([
  'title', 'description', 'keywords', 'siteUrl', 'timezone', 'lang',
  'allowRegister', 'pageSize', 'postsListSize', 'commentsListSize',
  'defaultAllowComment', 'defaultAllowPing', 'defaultAllowFeed',
  'feedFullText', 'markdown', 'postDateFormat', 'commentDateFormat',
  'commentsRequireMail', 'commentsRequireURL', 'commentsRequireModeration',
  'commentsWhitelist', 'commentsMaxNestingLevels',
  'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
  'commentsPageBreak', 'commentsThreaded', 'commentsPageSize',
  'commentsPageDisplay', 'commentsOrder', 'commentsCheckReferer',
  'commentsAutoClose', 'commentsPostIntervalEnable',
  'commentsAntiSpam', 'commentsHTMLTagAllowed', 'commentsAvatar',
  'commentsAvatarRating', 'commentsShowCommentOnly',
  'frontPage', 'frontArchive', 'attachmentTypes', 'editorSize',
  'cacheEnabled', 'loginFailBanEnabled', 'loginFailBanWindowSeconds',
  'loginFailBanMaxFailures', 'loginFailBanSeconds', 'feedItems',
  'robotsTxt',
]);

const BOOLEAN_KEYS = new Set([
  'allowRegister', 'defaultAllowComment', 'defaultAllowPing',
  'defaultAllowFeed', 'feedFullText', 'markdown', 'commentsRequireMail',
  'commentsRequireURL', 'commentsRequireModeration', 'commentsWhitelist',
  'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
  'commentsPageBreak', 'commentsThreaded', 'commentsCheckReferer',
  'commentsAutoClose', 'commentsPostIntervalEnable', 'commentsAntiSpam',
  'commentsAvatar', 'commentsShowCommentOnly', 'frontArchive',
  'cacheEnabled', 'loginFailBanEnabled',
]);

const CHECKBOXES_BY_PAGE: Record<string, readonly string[]> = {
  '/admin/options-general': ['allowRegister', 'cacheEnabled'],
  '/admin/options-discussion': [
    'commentsShowCommentOnly', 'commentsAvatar', 'commentsShowUrl',
    'commentsMarkdown', 'commentsUrlNofollow', 'commentsRequireMail',
    'commentsRequireURL', 'commentsCheckReferer', 'commentsAntiSpam',
    'commentsRequireModeration', 'commentsWhitelist', 'commentsAutoClose',
    'commentsThreaded', 'commentsPageBreak', 'commentsPostIntervalEnable',
  ],
  '/admin/options-reading': ['feedFullText', 'markdown'],
};

const INTEGER_RANGES: Record<string, readonly [number, number]> = {
  pageSize: [1, 100],
  postsListSize: [1, 100],
  commentsListSize: [1, 100],
  commentsPageSize: [1, 100],
  commentsMaxNestingLevels: [1, 20],
  editorSize: [100, 2_000],
  loginFailBanWindowSeconds: [10, 86_400],
  loginFailBanMaxFailures: [1, 100],
  loginFailBanSeconds: [10, 86_400],
  feedItems: [5, 50],
};

const ENUMS: Record<string, ReadonlySet<string>> = {
  commentsPageDisplay: new Set(['first', 'last']),
  commentsOrder: new Set(['ASC', 'DESC']),
  commentsAvatarRating: new Set(['G', 'PG', 'R', 'X']),
};

function invalid(field: string, detail: string): never {
  throw new SiteOptionsInputError(field, `Invalid ${field}: ${detail}`);
}

function parseInteger(field: string, raw: string, min: number, max: number): string {
  if (!/^-?\d+$/.test(raw.trim())) invalid(field, `expected an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(field, `expected an integer from ${min} to ${max}`);
  }
  return String(value);
}

function normalizeSiteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    invalid('siteUrl', 'expected an HTTP(S) origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid('siteUrl', 'expected an HTTP(S) origin');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    invalid('siteUrl', 'credentials, paths, queries, and fragments are not allowed');
  }
  return url.origin;
}

function normalizePattern(field: string, raw: string, kind: PermalinkPatternKind, fallback: string): string {
  const pattern = raw.trim() || fallback;
  if (!compilePermalinkPattern(pattern, kind)) invalid(field, `invalid ${kind} pattern`);
  return pattern;
}

export interface ParseSiteOptionsInput {
  formData: FormData;
  sourcePath: string;
}

/** Parse and validate a complete settings submission before any write occurs. */
export function parseSiteOptionsInput({ formData, sourcePath }: ParseSiteOptionsInput): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const key of OPTION_KEYS) {
    const value = formData.get(key);
    if (typeof value === 'string') entries[key] = value;
  }

  const pageCheckboxes = Object.entries(CHECKBOXES_BY_PAGE)
    .find(([page]) => sourcePath === page || sourcePath.startsWith(`${page}/`));
  if (pageCheckboxes) {
    for (const key of pageCheckboxes[1]) {
      entries[key] = formData.has(key) ? String(formData.get(key)) : '0';
    }
  }

  const permalinkValue = formData.get('permalinkPattern');
  if (typeof permalinkValue === 'string') {
    const raw = permalinkValue === 'custom'
      ? String(formData.get('customPattern') ?? '')
      : permalinkValue;
    entries.permalinkPattern = normalizePattern('permalinkPattern', raw, 'post', DEFAULT_PERMALINK_PATTERNS.post);
  }
  const pagePattern = formData.get('pagePattern');
  if (typeof pagePattern === 'string') {
    entries.pagePattern = normalizePattern('pagePattern', pagePattern, 'page', DEFAULT_PERMALINK_PATTERNS.page);
  }
  const categoryPattern = formData.get('categoryPattern');
  if (typeof categoryPattern === 'string') {
    entries.categoryPattern = normalizePattern('categoryPattern', categoryPattern, 'category', DEFAULT_PERMALINK_PATTERNS.category);
  }

  const timeoutDays = formData.get('commentsPostTimeout');
  if (typeof timeoutDays === 'string') {
    const days = Number(parseInteger('commentsPostTimeout', timeoutDays, 1, 3_650));
    entries.commentsPostTimeout = String(days * 86_400);
  }
  const intervalMinutes = formData.get('commentsPostInterval');
  if (typeof intervalMinutes === 'string') {
    const minutes = Number(parseInteger('commentsPostInterval', intervalMinutes, 1, 1_440));
    entries.commentsPostInterval = String(minutes * 60);
  }

  if (entries.siteUrl !== undefined) entries.siteUrl = normalizeSiteUrl(entries.siteUrl);
  if (entries.lang !== undefined && normalizeLocale(entries.lang) === null) {
    invalid('lang', 'expected an empty value or a valid locale tag');
  }
  if (entries.timezone !== undefined) {
    const timezone = entries.timezone.trim();
    if (!isIanaTimezone(timezone)) {
      invalid('timezone', 'expected a supported IANA time zone identifier');
    }
    entries.timezone = timezone;
  }

  for (const key of BOOLEAN_KEYS) {
    if (entries[key] !== undefined && entries[key] !== '0' && entries[key] !== '1') {
      invalid(key, 'expected 0 or 1');
    }
  }
  for (const [key, [min, max]] of Object.entries(INTEGER_RANGES)) {
    if (entries[key] !== undefined) entries[key] = parseInteger(key, entries[key], min, max);
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (entries[key] !== undefined && !allowed.has(entries[key])) {
      invalid(key, `expected one of ${[...allowed].join(', ')}`);
    }
  }

  return entries;
}
