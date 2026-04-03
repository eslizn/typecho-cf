import type { APIRoute } from 'astro';
import { clearAuthCookieHeaders } from '@/lib/auth';

/**
 * Logout — POST only to prevent CSRF via <img> tags.
 * GET kept for backward compat but redirects to home without clearing cookies.
 */
export const POST: APIRoute = async () => {
  const cookieHeaders = clearAuthCookieHeaders();
  const headers = new Headers();
  headers.set('Location', '/');
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
};

export const GET: APIRoute = async () => {
  // GET logout kept for backward compat — just redirect
  const cookieHeaders = clearAuthCookieHeaders();
  const headers = new Headers();
  headers.set('Location', '/');
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
};
