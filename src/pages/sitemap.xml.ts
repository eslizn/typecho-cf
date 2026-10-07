import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { escapeXml } from '@/lib/escape';
import { and, eq, lte, or, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

const SITEMAP_SHARD_SIZE = 1000;

export const GET: APIRoute = async () => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const nowSec = Math.floor(Date.now() / 1000);

  const ranked = db
    .select({
      cid: schema.contents.cid,
      modified: schema.contents.modified,
      ordinal: sql<number>`ROW_NUMBER() OVER (ORDER BY ${schema.contents.modified} DESC, ${schema.contents.cid} DESC)`.as('ordinal'),
    })
    .from(schema.contents)
    .where(publicContentFilter(nowSec))
    .as('ranked_sitemap_contents');

  // Keep only one cursor per shard in memory; the window query ranks rows in
  // SQLite, and every shard later reads its own bounded keyset page.
  const anchors = await db
    .select({ cid: ranked.cid, modified: ranked.modified })
    .from(ranked)
    .where(sql`${ranked.ordinal} % ${SITEMAP_SHARD_SIZE} = 1`)
    .orderBy(sql.raw('ordinal'));

  const baseUrl = urls.siteUrl.replace(/\/+$/, '');
  const entries = anchors.map((anchor, index) => {
    const location = new URL(`${baseUrl}/sitemap/${index + 1}.xml`);
    location.searchParams.set('cursor', encodeCursor(anchor.modified, anchor.cid));
    return `  <sitemap>\n    <loc>${escapeXml(location.toString())}</loc>\n  </sitemap>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
  return xmlResponse(xml);
};

export function publicContentFilter(nowSec: number) {
  return and(
    or(eq(schema.contents.type, 'post'), eq(schema.contents.type, 'page')),
    eq(schema.contents.status, 'publish'),
    lte(schema.contents.created, nowSec),
  );
}

export function encodeCursor(modified: number | null, cid: number): string {
  return `${modified === null ? 'n' : modified}:${cid}`;
}

export function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
}

export { SITEMAP_SHARD_SIZE };
