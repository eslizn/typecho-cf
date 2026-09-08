/**
 * Centralised string-escaping helpers.
 *
 * Splitting these out of feed.ts and markdown.ts keeps the choice of
 * &apos; vs &#39; explicit at the call site (XML attributes vs HTML
 * attributes) and lets the escapeCData defence sit in one place.
 */

/** Escape characters unsafe in HTML body / attribute values. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape characters unsafe in XML attribute values (RSS/Atom). */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Defuse `]]>` sequences inside a CDATA payload. Without this an attacker
 * who controls part of a feed item could close the CDATA block early
 * and inject sibling XML.
 */
export function escapeCData(str: string): string {
  return str.replace(/]]>/g, ']]]]><![CDATA[>');
}

/**
 * Escape a string for use inside a double-quoted HTML attribute. Slightly
 * narrower than escapeHtml — leaves &gt; alone since it isn't required by
 * the spec inside attributes, which marginally reduces output size.
 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Serialize a small data object for an inline script without allowing HTML
 * parser termination or JavaScript line-separator injection. */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
