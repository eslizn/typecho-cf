/**
 * Centralised security response-header construction.
 *
 * Splitting this out of middleware.ts lets the same builder serve both
 * normal HTML routes (full CSP) and worker-managed early responses
 * (install redirect, asset proxy) without each call site reinventing
 * directives.
 */
import { applyFilterSafely } from '@/lib/plugin';

/**
 * The default Content-Security-Policy. Tuned for the bundled minimal
 * theme + the four built-in plugins (turnstile injects scripts from
 * challenges.cloudflare.com, the markdown sanitizer permits embedded
 * youtube/bilibili/vimeo iframes, and gravatar URLs are images).
 *
 * Plugins that need extra origins can extend the directives via the
 * `csp:directives` filter hook instead of editing this map.
 */
export type CspDirectives = Record<string, string[]>;

export function defaultCspDirectives(): CspDirectives {
  return {
    'default-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'https://www.gravatar.com', 'https:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'script-src': ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https://challenges.cloudflare.com'],
    'frame-src': [
      'https://www.youtube.com',
      'https://player.bilibili.com',
      'https://player.vimeo.com',
      'https://challenges.cloudflare.com',
    ],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
}

/**
 * Mutate a directive map: add new sources to a key, deduping. Used by
 * plugin authors via the csp:directives filter hook.
 */
export function addCspSource(directives: CspDirectives, key: string, sources: string[]): void {
  const existing = new Set(directives[key] || []);
  for (const src of sources) existing.add(src);
  directives[key] = Array.from(existing);
}

export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .filter(([, srcs]) => srcs && srcs.length > 0)
    .map(([key, srcs]) => `${key} ${srcs.join(' ')}`)
    .join('; ');
}

export interface SecurityHeaderContext {
  request?: Request;
  /**
   * Set when the response is for an upload-served file. We tighten the
   * policy considerably because user-uploaded assets shouldn't be able
   * to source code from anywhere — including the site itself.
   */
  upload?: boolean;
}

/**
 * Apply the project's standard security headers to a Response. Existing
 * headers are preserved (the route handler had a chance to override
 * before us). HSTS only fires for https requests so dev http on
 * localhost still works (G8-6 / G1-8 alignment).
 */
export async function applySecurityHeaders(
  response: Response,
  ctx: SecurityHeaderContext = {},
): Promise<Response> {
  const proto = ctx.request ? safeProtocol(ctx.request.url) : 'https:';
  const isHttps = proto === 'https:';

  // Build CSP — for upload responses use a locked-down policy; otherwise
  // start from defaults and let plugins extend via filter hook.
  let cspString: string;
  if (ctx.upload) {
    cspString = "default-src 'none'; sandbox; style-src 'unsafe-inline'";
  } else {
    let directives = defaultCspDirectives();
    try {
      const filtered = await applyFilterSafely('csp:directives', directives, { request: ctx.request });
      if (filtered && typeof filtered === 'object') {
        directives = filtered as CspDirectives;
      }
    } catch {
      // Plugin failures already logged by applyFilterSafely.
    }
    cspString = serializeCsp(directives);
  }

  const additions: Array<[string, string]> = [
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', ctx.upload ? 'same-origin' : 'same-site'],
    ['Content-Security-Policy', cspString],
  ];
  if (isHttps) additions.push(['Strict-Transport-Security', 'max-age=31536000; includeSubDomains']);

  // Skip if all are already present — avoids cloning the response when
  // a previous middleware has already done the work.
  const have = (key: string) => response.headers.has(key);
  if (additions.every(([key]) => have(key))) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of additions) {
    if (!headers.has(key)) headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safeProtocol(url: string): string {
  try { return new URL(url).protocol; } catch { return 'https:'; }
}
