/**
 * Content-path whitelist.
 *
 * Front-end content URLs are only served when they match one of the admin
 * permalink patterns (post / page / category). The default URL forms
 * (/archives/{cid}/, /{slug}, /category/{slug}/) are allowed while the
 * corresponding pattern is still the default, and rejected once a custom
 * pattern is configured. /contents/{cid}/ is the unified content render
 * entry (the internal rewrite target for posts and pages); it is never a
 * public URL, so a direct unmarked request is always rejected here.
 * Non-content routes (index, tag, author, search, feeds, admin, API,
 * uploads) are never gated.
 */
import {
  compilePermalinkPattern,
  decodePathnameForMatching,
  DEFAULT_PERMALINK_PATTERNS,
} from '@/lib/permalink-pattern';

export const MONTH_ARCHIVE_PATH = /^\/\d{4}\/(?:0[1-9]|1[0-2])\/?$/;

export interface ContentPathOptions {
  permalinkPattern?: string | null;
  pagePattern?: string | null;
  categoryPattern?: string | null;
}

// Content-shaped routes: the default URL forms (archives/[cid]/, /{slug},
// category/[slug]/) plus the unified content entry contents/[cid]/ that the
// middleware rewrites posts and pages into. /archives/{cid}/ must stay here
// (not in middleware's BUILT_IN_ROUTES) so the whitelist can deprecate it
// once a custom post pattern is set, while the middleware re-writes the
// default form to /contents/{cid}/. The middleware passes the
// pagination-normalized effective path (/page/N/ is already stripped).
export const CONTENT_ROUTE_PATHS = [
  /^\/archives\/\d+\/?$/,
  /^\/contents\/\d+\/?$/,
  /^\/[^/]+$/,
  /^\/category\/[^/]+\/?$/,
];

// The bare-slug page form /{slug} overlaps fixed single-segment surfaces
// (admin, install, feeds, the bare /search entry, sitemap, robots, upload
// root, ...). Those are
// never content URLs and must not be gated here, otherwise a custom page
// pattern would 404 them. Plugin front-end routes (e.g. WebDAV) are NOT
// listed here: middleware exempts them via the plugin route table
// (isPluginRoute) instead, keeping plugin paths dynamic.
const FIXED_SINGLE_SEGMENT = /^\/(?:admin|install|feed|search|usr|sitemap\.xml|robots\.txt)(?:\/|$)/;

function isContentShaped(path: string): boolean {
  if (FIXED_SINGLE_SEGMENT.test(path)) return false;
  return CONTENT_ROUTE_PATHS.some((re) => re.test(path));
}

/**
 * True when the path is allowed to reach the content routes. Non-content
 * paths always pass; content-shaped paths must match at least one configured
 * permalink pattern (compiled, so overlapping spellings like `/archives/{cid}`
 * still match their own canonical URLs).
 */
export function isContentPathAllowed(
  path: string,
  options: ContentPathOptions,
): boolean {
  if (!isContentShaped(path)) return true;

  const matchPath = decodePathnameForMatching(path);
  const postPattern = compilePermalinkPattern(options.permalinkPattern ?? DEFAULT_PERMALINK_PATTERNS.post, 'post');
  const pagePattern = compilePermalinkPattern(options.pagePattern ?? DEFAULT_PERMALINK_PATTERNS.page, 'page');
  const categoryPattern = compilePermalinkPattern(options.categoryPattern ?? DEFAULT_PERMALINK_PATTERNS.category, 'category');

  return postPattern?.test(matchPath) || pagePattern?.test(matchPath) || categoryPattern?.test(matchPath) || false;
}