import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async () => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const custom = (options.robotsTxt as string | undefined) || '';

  let body: string;
  if (custom.trim()) {
    body = custom.trim();
    // AGENTS.md §9.1: /robots.txt always advertises the sitemap index.
    if (!/(^|\n)\s*Sitemap\s*:/i.test(body)) {
      body += `\n\nSitemap: ${urls.siteUrl}/sitemap.xml`;
    }
    body += '\n';
  } else {
    body = `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${urls.siteUrl}/sitemap.xml\n`;
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
};
