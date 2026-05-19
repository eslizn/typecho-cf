import { shouldUseSecureCookie } from '@/lib/auth';

const DEFAULT_MAX_AGE = 60;
const DEFAULT_PATH = '/';
const MAX_FLASH_LENGTH = 500;

export const LOGIN_ERROR_FLASH_COOKIE = '__typecho_login_error';
export const REGISTER_NOTICE_FLASH_COOKIE = '__typecho_register_notice';

export function createFlashCookieHeader(
  name: string,
  value: string,
  options: { maxAge?: number; path?: string; request?: Request } = {},
): string {
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const path = options.path ?? DEFAULT_PATH;
  const encoded = encodeURIComponent(value.slice(0, MAX_FLASH_LENGTH));
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

export function getFlashCookieValue(cookieHeader: string | null, name: string): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

export function createFlashRedirectHeaders(location: string, name: string, value: string, path = '/', request?: Request): Headers {
  const headers = new Headers();
  headers.set('Location', location);
  headers.append('Set-Cookie', createFlashCookieHeader(name, value, { path, request }));
  return headers;
}
