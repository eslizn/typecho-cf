import type { APIRoute } from 'astro';
import { getFromR2 } from '@/lib/upload';
import { applySecurityHeaders } from '@/lib/security-headers';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const path = `usr/uploads/${params.path}`;
  const bucket = env.BUCKET;

  try {
    const object = await getFromR2(bucket, path);
    if (!object) {
      return new Response('Not Found', { status: 404 });
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

    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);

    // applySecurityHeaders adds the upload-specific tightened CSP
    // (default-src 'none'; sandbox; ...) and CORP same-origin so a
    // user-uploaded HTML/SVG file can never source code from the rest
    // of the site even if Content-Type detection is wrong.
    return await applySecurityHeaders(new Response(object.body, { headers }), { request, upload: true });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
};
