import type { APIRoute } from 'astro';
import { clearAuthCookieHeaders } from '@/lib/auth';

export const GET: APIRoute = async ({ redirect }) => {
  const cookieHeaders = clearAuthCookieHeaders();

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': cookieHeaders.join(', '),
    },
  });
};

export const POST: APIRoute = GET;
