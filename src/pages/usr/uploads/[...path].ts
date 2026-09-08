import type { APIRoute } from 'astro';
import { getFromR2 } from '@/lib/upload';
import { applySecurityHeaders } from '@/lib/security-headers';
import { getRequestCoreContextFromLocals } from '@/lib/context';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const path = `usr/uploads/${params.path}`;
  const bucket = env.BUCKET;
  const cache = caches.default;
  const i18n = getRequestCoreContextFromLocals(locals)?.i18n ?? createCoreRequestI18n(request).i18n;

  try {
    // Cache API entries are local to a PoP, so deleting one cache key from an
    // admin request cannot invalidate every edge. Resolve the current R2 ETag
    // first and include it in the internal cache key instead: deleted objects
    // fail before cache lookup, while replacements automatically use a new key.
    const metadata = await bucket.head(path);
    if (!metadata) {
      return new Response(i18n.t('core.error.notFound', {}, 'Not Found'), { status: 404 });
    }
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.set('__typecho_upload_etag', metadata.httpEtag);
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

    const cached = await cache.match(cacheKey).catch(() => undefined);
    if (cached) return browserRevalidatedResponse(cached);

    const object = await getFromR2(bucket, path);
    if (!object) {
      return new Response(i18n.t('core.error.notFound', {}, 'Not Found'), { status: 404 });
    }

    const headers = new Headers();
    const mimeType = object.httpMetadata?.contentType || 'application/octet-stream';
    headers.set('Content-Type', mimeType);

    // G5-6: SVGs may contain inline scripts. Even though the upload
    // pipeline already pins Content-Disposition: attachment for them,
    // we re-pin here in case the bucket has older entries created
    // before the SVG hardening landed.
    if (mimeType === 'image/svg+xml') {
      headers.set('Content-Disposition', object.httpMetadata?.contentDisposition || 'attachment');
    } else if (object.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', object.httpMetadata.contentDisposition);
    }

    // This long lifetime is only for our ETag-versioned internal Cache API
    // entry. The browser-facing response is rewritten to revalidate so a
    // deleted private upload cannot remain visible from the browser cache.
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);

    // applySecurityHeaders adds the upload-specific tightened CSP
    // (default-src 'none'; sandbox; ...) and CORP same-origin so a
    // user-uploaded HTML/SVG file can never source code from the rest
    // of the site even if Content-Type detection is wrong.
    const response = await applySecurityHeaders(
      new Response(object.body, { headers }),
      { request, upload: true },
    );
    // Cache failures must never turn a successfully-read object into a 404.
    const cacheWrite = cache.put(cacheKey, response.clone()).catch((error: unknown) => {
      console.warn({
        event: 'upload_cache_write_failed',
        path,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    if (locals.cfContext) {
      locals.cfContext.waitUntil(cacheWrite);
    } else {
      await cacheWrite;
    }
    return browserRevalidatedResponse(response);
  } catch {
    return new Response(i18n.t('core.error.notFound', {}, 'Not Found'), { status: 404 });
  }
};

function browserRevalidatedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
