import type { APIRoute } from 'astro';
import { getFromR2 } from '@/lib/upload';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params, locals }) => {
  const path = `usr/uploads/${params.path}`;
  const bucket = env.BUCKET;

  try {
    const object = await getFromR2(bucket, path);
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    if (object.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', object.httpMetadata.contentDisposition);
    }
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);

    return new Response(object.body, { headers });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
};
