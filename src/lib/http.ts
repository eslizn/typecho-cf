/**
 * Standardized error response helpers.
 *
 * Front-end HTML routes (comment posting, install, etc.) use plain-text
 * responses because they are consumed by browsers and rendered by
 * server error pages. Admin JSON APIs use `{ error: string }` shape so
 * client code can parse without content-negotiation.
 *
 * Use `textError(status, message)` for user-facing HTML flows.
 * Use `jsonError(status, message)` for admin/API JSON responses. A message
 * descriptor is resolved here when the request-local translator is supplied;
 * legacy literal strings keep the old response shape.
 */

import type { I18n, I18nMessage } from '@/lib/i18n';
import { normalizeI18nMessage, resolveI18nMessage } from '@/lib/i18n';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
export type HttpMessage = string | I18nMessage;

export function textError(status: number, message: HttpMessage, extraHeaders?: HeadersInit, i18n?: I18n): Response {
  const descriptor = typeof message === 'string' ? null : normalizeI18nMessage(message);
  const headers = new Headers(extraHeaders);
  // Native admin form submissions are redirected by middleware. Preserve the
  // stable descriptor in bounded headers so the redirect can re-render the
  // message in the next request's locale instead of freezing translated text.
  if (descriptor) {
    headers.set('X-Typecho-I18n-Code', descriptor.key);
    if (descriptor.variables && Object.keys(descriptor.variables).length > 0) {
      headers.set('X-Typecho-I18n-Params', JSON.stringify(descriptor.variables));
    }
  }
  return new Response(resolveI18nMessage(message, i18n), { status, headers });
}

export function jsonError(status: number, message: HttpMessage, extraHeaders?: Record<string, string>, i18n?: I18n): Response {
  const headers = extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS;
  const descriptor = typeof message === 'string' ? null : normalizeI18nMessage(message);
  const body: Record<string, unknown> = {
    error: descriptor
      ? resolveI18nMessage(descriptor, i18n)
      : typeof message === 'string'
        ? message
        : status >= 500
          ? 'Request failed'
          : 'Invalid request',
  };
  if (descriptor) {
    body.code = descriptor.key;
    if (descriptor.variables && Object.keys(descriptor.variables).length > 0) {
      body.params = descriptor.variables;
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function jsonOk<T>(body: T, extraHeaders?: Record<string, string>): Response {
  const headers = extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS;
  return new Response(JSON.stringify(body), { status: 200, headers });
}
