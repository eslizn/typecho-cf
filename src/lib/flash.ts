import { shouldUseSecureCookie } from '@/lib/auth';
import type { I18n, I18nMessage } from '@/lib/i18n';
import { normalizeI18nMessage, resolveI18nMessage } from '@/lib/i18n';

const DEFAULT_MAX_AGE = 60;
const DEFAULT_PATH = '/';
const MAX_FLASH_LENGTH = 500;
export type FlashMessage = string | I18nMessage;

export const LOGIN_ERROR_FLASH_COOKIE = '__typecho_login_error';
export const REGISTER_NOTICE_FLASH_COOKIE = '__typecho_register_notice';

export function createFlashCookieHeader(
  name: string,
  value: FlashMessage,
  options: { maxAge?: number; path?: string; request?: Request } = {},
): string {
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const path = options.path ?? DEFAULT_PATH;
  const encoded = encodeURIComponent(serializeFlashMessage(value));
  const secureFlag = shouldUseSecureCookie(options.request) ? '; Secure' : '';
  return `${name}=${encoded}; Path=${path}; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearFlashCookieHeader(
  name: string,
  options: { path?: string; request?: Request } = {},
): string {
  const path = options.path ?? DEFAULT_PATH;
  const secureFlag = shouldUseSecureCookie(options.request) ? '; Secure' : '';
  return `${name}=; Path=${path}; HttpOnly${secureFlag}; SameSite=Lax; Max-Age=0`;
}

export function getFlashCookieValue(cookieHeader: string | null, name: string, i18n?: I18n): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      const decoded = decodeURIComponent(rawValue.join('='));
      const descriptor = parseFlashDescriptor(decoded);
      return descriptor ? resolveI18nMessage(descriptor, i18n) : decoded;
    } catch {
      return '';
    }
  }
  return '';
}

export function createFlashRedirectHeaders(location: string, name: string, value: FlashMessage, path = '/', request?: Request): Headers {
  const headers = new Headers();
  headers.set('Location', location);
  headers.append('Set-Cookie', createFlashCookieHeader(name, value, { path, request }));
  return headers;
}

function serializeFlashMessage(value: FlashMessage): string {
  if (typeof value === 'string') return value.slice(0, MAX_FLASH_LENGTH);
  const descriptor = normalizeI18nMessage(value);
  if (!descriptor) return '';
  const encoded = JSON.stringify(descriptor);
  if (encoded.length <= MAX_FLASH_LENGTH) return encoded;
  // Keep the cookie bounded even when a caller supplies a large descriptor.
  // A short fallback remains displayable for clients that do not know i18n.
  return (descriptor.fallbackText || descriptor.key).slice(0, MAX_FLASH_LENGTH);
}

function parseFlashDescriptor(value: string): I18nMessage | null {
  if (!value.startsWith('{') || value.length > MAX_FLASH_LENGTH) return null;
  try {
    return normalizeI18nMessage(JSON.parse(value));
  } catch {
    return null;
  }
}
