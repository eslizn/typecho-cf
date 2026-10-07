import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { buildPermalink } from '@/lib/content';
import { escapeXml } from '@/lib/escape';
import { and, desc, eq, isNull, lte, lt, or } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { publicContentFilter, SITEMAP_SHARD_SIZE, xmlResponse } from '../sitemap.xml';

interface SitemapCursor {
  modified: number | null;
  cid: number;
}

export const GET: APIRoute = async ({ params, url }) => {
  const part = parsePart(params.part);
  const cursor = parseCursor(url.searchParams.get('cursor'));
  if (!part || (part > 1 && !cursor) || (url.searchParams.has('cursor') && !cursor)) {
    return new Response('Not Found', { status: 404 });
  }

  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const nowSec = Math.floor(Date.now() / 1000);
  const conditions = [publicContentFilter(nowSec)];
  if (cursor) conditions.push(continueAfterInclusiveCursor(cursor));

  const rows = await db
    .select({
      cid: schema.contents.cid,
      slug: schema.contents.slug,
      type: schema.contents.type,
      modified: schema.contents.modified,
      created: schema.contents.created,
    })
    .from(schema.contents)
    .where(and(...conditions))
    .orderBy(desc(schema.contents.modified), desc(schema.contents.cid))
    .limit(SITEMAP_SHARD_SIZE);

  const items = rows.map((row) => {
    const loc = buildPermalink(
      { cid: row.cid, slug: row.slug, type: row.type, created: row.created },
      urls.siteUrl,
      options.permalinkPattern as string | undefined,
      options.pagePattern as string | undefined,
    );
    const lastmod = new Date((row.modified || row.created || 0) * 1000)
      .toISOString()
      .slice(0, 10);
    return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>`;
  return xmlResponse(xml);
};

function parsePart(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const part = Number(value);
  return Number.isSafeInteger(part) ? part : null;
}

function parseCursor(value: string | null): SitemapCursor | null {
  if (!value) return null;
  const match = /^(n|-?\d+):([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const cid = Number(match[2]);
  const modified = match[1] === 'n' ? null : Number(match[1]);
  if (!Number.isSafeInteger(cid) || (modified !== null && !Number.isSafeInteger(modified))) return null;
  return { modified, cid };
}

/** The first row of a shard is included; later rows follow its sort key. */
function continueAfterInclusiveCursor(cursor: SitemapCursor) {
  if (cursor.modified === null) {
    return and(isNull(schema.contents.modified), lte(schema.contents.cid, cursor.cid));
  }
  return or(
    lt(schema.contents.modified, cursor.modified),
    and(eq(schema.contents.modified, cursor.modified), lte(schema.contents.cid, cursor.cid)),
    isNull(schema.contents.modified),
  );
}
