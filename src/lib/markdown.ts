import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { applyFilter, applyFilterSafely, type HookContext } from '@/lib/plugin';
import { escapeHtml as escapeHtmlShared } from '@/lib/escape';

// ─── HTML escape helper ─────────────────────────────────────────────────────

/** @deprecated Import from '@/lib/escape' directly. */
export function escapeHtml(str: string): string {
  return escapeHtmlShared(str);
}

// ─── Shared sanitize config ──────────────────────────────────────────────────

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'del', 'ins', 'details', 'summary', 'figure', 'figcaption',
    'video', 'audio', 'source', 'iframe',
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    a: ['href', 'title', 'target', 'rel'],
    code: ['class'],
    pre: ['class'],
    td: ['align', 'valign'],
    th: ['align', 'valign'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allowfullscreen'],
    video: ['src', 'controls', 'width', 'height'],
    audio: ['src', 'controls'],
    source: ['src', 'type'],
  },
  allowedIframeHostnames: ['www.youtube.com', 'player.bilibili.com', 'player.vimeo.com'],
};

const COMMENT_MARKDOWN_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'pre', 'code']),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    pre: ['class'],
  },
};

export interface CommentRenderOptions {
  markdown?: boolean;
  htmlTagAllowed?: string | null;
}

/**
 * Unique placeholder used to survive markdown rendering + sanitization.
 * Marked wraps a standalone line of plain text in <p>…</p>, so after
 * rendering the placeholder appears as <p>TYPECHO_MORE_0</p> which we
 * can reliably split on.
 */
const MORE_PLACEHOLDER = 'TYPECHO_MORE_0';
const MORE_PLACEHOLDER_RE = /<p>\s*TYPECHO_MORE_0\s*<\/p>/;
const MORE_COMMENT_RE = /<!--more-->/g;
const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

// ─── Strip <!--markdown--> prefix ────────────────────────────────────────────

const MARKDOWN_PREFIX = '<!--markdown-->';
const RENDER_CACHE_MAX_ENTRIES = 64;
const RENDER_CACHE_MAX_SOURCE_LENGTH = 100_000;

export interface RenderedContent {
  html: string;
  plainExcerpt: string;
}

const renderedContentCache = new Map<string, RenderedContent>();
const commentSanitizeOptionsCache = new Map<string, sanitizeHtml.IOptions>();
const COMMENT_SANITIZE_CACHE_MAX_ENTRIES = 32;

function stripMarkdownPrefix(text: string): string {
  return text.startsWith(MARKDOWN_PREFIX) ? text.slice(MARKDOWN_PREFIX.length) : text;
}

/**
 * Remove Typecho-specific markers from content: <!--markdown--> prefix and all <!--more--> tags.
 */
export function stripTypechoMarkers(text: string): string {
  return stripMarkdownPrefix(text).replace(MORE_COMMENT_RE, '');
}

/**
 * Strip all HTML tags and collapse whitespace to single spaces.
 */
export function stripHtmlTags(html: string): string {
  return html.replace(HTML_TAG_RE, ' ').replace(WHITESPACE_RE, ' ').trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Render markdown to HTML (synchronous, no plugin hooks)
 */
export function renderMarkdown(text: string): string {
  return renderContent(text).html;
}

/**
 * Parse and sanitize content once, deriving both the full HTML and its plain
 * excerpt. A small bounded isolate cache lets archive and feed rendering reuse
 * the same result without retaining arbitrarily large articles.
 */
export function renderContent(text: string, maxExcerptLength = 200): RenderedContent {
  if (!text) return { html: '', plainExcerpt: '' };

  const cacheable = maxExcerptLength === 200 && text.length <= RENDER_CACHE_MAX_SOURCE_LENGTH;
  const cached = cacheable ? renderedContentCache.get(text) : undefined;
  if (cached) {
    // Refresh insertion order for LRU eviction.
    renderedContentCache.delete(text);
    renderedContentCache.set(text, cached);
    return cached;
  }

  const content = stripMarkdownPrefix(text).replace(MORE_COMMENT_RE, '');
  const parsed = marked.parse(content, { async: false }) as string;
  const html = sanitizeHtml(parsed, SANITIZE_OPTIONS);
  const plain = stripHtmlTags(parsed);
  const plainExcerpt = plain.length <= maxExcerptLength
    ? plain
    : `${plain.substring(0, maxExcerptLength)}...`;
  const rendered = { html, plainExcerpt };

  if (cacheable) {
    renderedContentCache.set(text, rendered);
    if (renderedContentCache.size > RENDER_CACHE_MAX_ENTRIES) {
      const oldest = renderedContentCache.keys().next().value;
      if (oldest !== undefined) renderedContentCache.delete(oldest);
    }
  }
  return rendered;
}

export function renderCommentText(text: string, options: CommentRenderOptions = {}): string {
  if (!text) return '';

  const sanitizeOptions = buildCommentSanitizeOptions(options.htmlTagAllowed, !!options.markdown);
  if (options.markdown) {
    const html = marked.parse(stripMarkdownPrefix(text), { async: false }) as string;
    return sanitizeHtml(html, sanitizeOptions);
  }

  const sanitized = sanitizeHtml(text, sanitizeOptions);
  return autop(sanitized);
}

/** Render a comment while allowing presentation-only plugin filters. */
export async function renderCommentTextFiltered(
  ctx: HookContext,
  text: string,
  options: CommentRenderOptions = {},
): Promise<string> {
  if (!text) return '';

  let source = stripMarkdownPrefix(text);
  const sanitizeOptions = buildCommentSanitizeOptions(options.htmlTagAllowed, !!options.markdown);
  let rendered: string;
  if (options.markdown) {
    const filteredSource = await applyFilterSafely(ctx, 'comment:markdown', source);
    if (typeof filteredSource === 'string') source = filteredSource;
    rendered = sanitizeHtml(marked.parse(source, { async: false }) as string, sanitizeOptions);
  } else {
    rendered = autop(sanitizeHtml(source, sanitizeOptions));
  }
  const filteredRendered = await applyFilterSafely(ctx, 'comment:rendered', rendered);
  return typeof filteredRendered === 'string' ? filteredRendered : rendered;
}

/**
 * Render markdown to HTML with plugin filter hooks (async)
 * Use this for content display where plugins should be able to intercept
 */
export async function renderMarkdownFiltered(ctx: HookContext, text: string): Promise<string> {
  if (!text) return '';

  let content = stripMarkdownPrefix(text);
  // Remove <!--more--> from full-content renders — it is only meaningful
  // for list/excerpt views where renderContentExcerpt() is used instead.
  content = content.replace(MORE_COMMENT_RE, '');

  // Apply content:markdown filter — plugins can modify the raw markdown
  const filteredContent = await applyFilter(ctx, 'content:markdown', content);
  if (typeof filteredContent === 'string') content = filteredContent;

  const html = marked.parse(content, { async: false }) as string;
  let sanitized = sanitizeHtml(html, SANITIZE_OPTIONS);

  // Apply content:rendered filter — plugins can modify the rendered HTML
  const filteredRendered = await applyFilter(ctx, 'content:rendered', sanitized);
  if (typeof filteredRendered === 'string') sanitized = filteredRendered;

  return sanitized;
}

/**
 * Render content with <!--more--> support.
 *
 * The full markdown source is rendered first so that reference-style links,
 * footnotes, and other constructs that span the <!--more--> boundary are
 * resolved correctly.  Only after a complete render is the output split at
 * the <!--more--> marker to produce the excerpt.
 */
export function renderContentExcerpt(
  text: string,
  moreText = '- Read more -',
  permalink = '#'
): string {
  if (!text) return '';

  const content = stripMarkdownPrefix(text);

  if (!content.includes('<!--more-->')) {
    return renderMarkdown(text);
  }

  // Surround the marker with blank lines before substituting the placeholder.
  // This guarantees that marked wraps the placeholder in its own <p> block
  // regardless of whether the author placed <!--more--> inline or between
  // paragraphs — enabling a clean split on the rendered output.
  const withPlaceholder = content.replace(MORE_COMMENT_RE, '\n\n' + MORE_PLACEHOLDER + '\n\n');
  const html = marked.parse(withPlaceholder, { async: false }) as string;
  const sanitized = sanitizeHtml(html, SANITIZE_OPTIONS);

  // Split on the rendered placeholder and keep only the excerpt (part before it).
  const excerptHtml = sanitized.split(MORE_PLACEHOLDER_RE)[0];
  return `${excerptHtml}<p class="more"><a href="${escapeHtml(permalink)}" title="${escapeHtml(moreText)}">${escapeHtml(moreText)}</a></p>`;
}

/**
 * Generate plain text excerpt from content
 */
export function generateExcerpt(text: string, maxLength = 200): string {
  return renderContent(text, maxLength).plainExcerpt;
}

/**
 * Auto-paragraph helper. Splits on blank lines and wraps each paragraph
 * in `<p>...</p>` unless it already starts with a recognised block-level
 * element. Single newlines inside a paragraph become `<br />`.
 *
 * Wrapping a chunk that already contains `<p>` / `<div>` / `<h1>` etc
 * produces invalid HTML (`<p><div>...</div></p>`); browsers tolerate it
 * but the output then breaks downstream sanitizers and CSS selectors.
 */
const BLOCK_OPEN_RE = /^\s*<(p|div|section|article|aside|header|footer|nav|figure|figcaption|blockquote|pre|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|h[1-6]|hr|details|summary|form|fieldset)\b/i;

export function autop(text: string): string {
  if (!text) return '';
  text = text.replace(/\r\n|\r/g, '\n');
  text = text.replace(/\n\n+/g, '\n\n');
  const paragraphs = text.split('\n\n');
  return paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      if (BLOCK_OPEN_RE.test(p)) return p;
      return `<p>${p.replace(/\n/g, '<br />')}</p>`;
    })
    .join('\n');
}

function buildCommentSanitizeOptions(htmlTagAllowed?: string | null, markdown = false): sanitizeHtml.IOptions {
  const cacheKey = `${markdown ? '1' : '0'}\0${htmlTagAllowed || ''}`;
  const cached = commentSanitizeOptionsCache.get(cacheKey);
  if (cached) return cached;

  const parsed = parseAllowedHtmlTags(htmlTagAllowed);
  let result: sanitizeHtml.IOptions;
  if (!parsed) {
    result = markdown ? COMMENT_MARKDOWN_OPTIONS : {
      allowedTags: [],
      allowedAttributes: {},
    };
  } else if (!markdown) {
    result = {
      allowedTags: parsed.allowedTags,
      allowedAttributes: parsed.allowedAttributes,
      // Carry the default schemes through so links survive the sanitizer.
      allowedSchemes: sanitizeHtml.defaults.allowedSchemes,
    };
  } else {
    result = {
      ...COMMENT_MARKDOWN_OPTIONS,
      allowedTags: [...new Set([...COMMENT_MARKDOWN_OPTIONS.allowedTags as string[], ...parsed.allowedTags])],
      allowedAttributes: mergeAllowedAttributes(COMMENT_MARKDOWN_OPTIONS.allowedAttributes || {}, parsed.allowedAttributes),
    };
  }

  commentSanitizeOptionsCache.set(cacheKey, result);
  if (commentSanitizeOptionsCache.size > COMMENT_SANITIZE_CACHE_MAX_ENTRIES) {
    const oldest = commentSanitizeOptionsCache.keys().next().value;
    if (oldest !== undefined) commentSanitizeOptionsCache.delete(oldest);
  }
  return result;
}

function parseAllowedHtmlTags(htmlTagAllowed?: string | null): {
  allowedTags: string[];
  allowedAttributes: Record<string, string[]>;
} | null {
  if (!htmlTagAllowed?.trim()) return null;

  const allowedTags: string[] = [];
  const allowedAttributes: Record<string, string[]> = {};
  const tagRe = /<\s*([a-zA-Z0-9]+)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(htmlTagAllowed)) !== null) {
    const tag = match[1].toLowerCase();
    allowedTags.push(tag);

    // Match either `name=` or a bare attribute name (e.g. `<a href>`).
    const attrs = [...match[2].matchAll(/([a-zA-Z0-9:-]+)(?=\s*=|\s|\/?>|$)/g)]
      .map(attr => attr[1].toLowerCase())
      .filter(attr => isSafeAttributeName(tag, attr));
    if (attrs.length > 0) {
      allowedAttributes[tag] = [...new Set([...(allowedAttributes[tag] || []), ...attrs])];
    }
  }

  return {
    allowedTags: [...new Set(allowedTags)],
    allowedAttributes,
  };
}

/**
 * Reject attribute names that are unsafe regardless of the tag they
 * appear on. Even though sanitize-html itself would normally filter
 * inline event handlers, the comment-form path lets administrators
 * declare a custom HTML allowlist via options.commentsHTMLTagAllowed —
 * a single typo there could otherwise re-enable XSS surface.
 *
 * The set deliberately leans towards over-rejection. Callers can
 * restore broader sets through plugin filters if needed.
 */
const ATTRIBUTE_GLOBAL_DENYLIST = new Set([
  'style', 'srcset', 'sandbox', 'allow', 'allowfullscreen',
  'formaction', 'action', 'background', 'dynsrc', 'lowsrc', 'ping',
  'poster', 'data',
]);

function isSafeAttributeName(tag: string, attr: string): boolean {
  if (attr.startsWith('on')) return false;
  if (attr.startsWith('xlink:') || attr.startsWith('xmlns')) return false;
  if (ATTRIBUTE_GLOBAL_DENYLIST.has(attr)) return false;
  // src is only meaningful on a small set of tags; reject elsewhere.
  if (attr === 'src' && !['img', 'audio', 'video', 'source', 'iframe'].includes(tag)) return false;
  // href is similarly restricted to anchors and (legacy) link tags.
  if (attr === 'href' && !['a', 'link', 'area'].includes(tag)) return false;
  return true;
}

function mergeAllowedAttributes(
  base: sanitizeHtml.IOptions['allowedAttributes'],
  extra: Record<string, string[]>,
): sanitizeHtml.IOptions['allowedAttributes'] {
  const merged: Record<string, string[]> = {};
  for (const [tag, attrs] of Object.entries(base || {})) {
    merged[tag] = Array.isArray(attrs) ? attrs.map(String) : [];
  }
  for (const [tag, attrs] of Object.entries(extra)) {
    merged[tag] = [...new Set([...(merged[tag] || []), ...attrs])];
  }
  return merged;
}
