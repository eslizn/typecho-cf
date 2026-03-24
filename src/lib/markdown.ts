import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { applyFilter } from '@/lib/plugin';

/**
 * Render markdown to HTML
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Typecho stores markdown with <!--markdown--> prefix
  let content = text;
  if (content.startsWith('<!--markdown-->')) {
    content = content.replace('<!--markdown-->', '');
  }

  const html = marked.parse(content, { async: false }) as string;
  return sanitizeHtml(html, {
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
  });
}

/**
 * Render markdown to HTML with plugin filter hooks (async)
 * Use this for content display where plugins should be able to intercept
 */
export async function renderMarkdownFiltered(text: string): Promise<string> {
  if (!text) return '';

  let content = text;
  if (content.startsWith('<!--markdown-->')) {
    content = content.replace('<!--markdown-->', '');
  }

  // Apply content:markdown filter — plugins can modify the raw markdown
  content = await applyFilter('content:markdown', content);

  const html = marked.parse(content, { async: false }) as string;
  let sanitized = sanitizeHtml(html, {
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
  });

  // Apply content:content filter — plugins can modify the rendered HTML
  sanitized = await applyFilter('content:content', sanitized);

  return sanitized;
}

/**
 * Render content with <!--more--> support
 * Returns truncated HTML with a "read more" link when needed
 */
export function renderContentExcerpt(
  text: string,
  moreText = '- 阅读剩余部分 -',
  permalink = '#'
): string {
  if (!text) return '';

  const moreIndex = text.indexOf('<!--more-->');
  if (moreIndex === -1) {
    return renderMarkdown(text);
  }

  const excerpt = text.substring(0, moreIndex);
  const html = renderMarkdown(excerpt);
  return `${html}<p class="more"><a href="${permalink}" title="${moreText}">${moreText}</a></p>`;
}

/**
 * Generate plain text excerpt from content
 */
export function generateExcerpt(text: string, maxLength = 200): string {
  if (!text) return '';

  const html = renderMarkdown(text);
  const plain = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= maxLength) return plain;
  return plain.substring(0, maxLength) + '...';
}

/**
 * Simple autop (auto paragraph) - converts line breaks to <p> tags
 * Used for non-markdown content
 */
export function autop(text: string): string {
  if (!text) return '';
  text = text.replace(/\r\n|\r/g, '\n');
  text = text.replace(/\n\n+/g, '\n\n');
  const paragraphs = text.split('\n\n');
  return paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}
