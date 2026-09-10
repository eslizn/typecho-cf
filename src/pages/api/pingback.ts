import type { APIRoute } from 'astro';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { getDb, schema, type Database } from '@/db';
import { loadOptions, type SiteOptions } from '@/lib/options';
import { getRequestCoreContextFromLocals, getClientIp } from '@/lib/context';
import { parseActivatedPlugins, setActivatedPlugins } from '@/lib/plugin';
import { INCOMING_FEEDBACK_RATE_LIMIT, saveIncomingFeedback } from '@/lib/incoming-feedback';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { compilePermalinkPattern, DEFAULT_PERMALINK_PATTERNS } from '@/lib/permalink-pattern';
import { nowSeconds } from '@/lib/content-visibility';
import { env } from 'cloudflare:workers';
import { InputError, readBoundedText } from '@/lib/input';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';

function xmlParams(xml: string): string[] {
  const pattern = /<param>\s*<value>(?:<string>)?([\s\S]*?)(?:<\/string>)?<\/value>\s*<\/param>/gi;
  return [...xml.matchAll(pattern)]
    .map(match => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));
  let xml: string;
  try { xml = await readBoundedText(request, REQUEST_BODY_LIMITS.publicForm); }
  catch (error) { return new Response(error instanceof Error ? error.message : 'invalid', { status: error instanceof InputError ? error.status : 400 }); }
  const [source, target] = xmlParams(xml);
  if (!source || !target) return new Response('invalid', { status: 400 });

  // Unauthenticated public endpoint: throttle per IP before touching D1.
  const ip = getClientIp(request);
  if (!trackSlidingWindow(`pingback:${ip}`, INCOMING_FEEDBACK_RATE_LIMIT)) {
    return new Response('rate-limited', {
      status: 429,
      headers: { 'Retry-After': String(INCOMING_FEEDBACK_RATE_LIMIT.windowSeconds) },
    });
  }

  const content = await resolvePingbackTarget(db, options, target);
  if (!content) return new Response('target-not-found', { status: 404 });
  const result = await saveIncomingFeedback(db, pluginCtx, options, {
    cid: content.cid, author: source, url: source, text: `Pingback from ${source}`,
    type: 'pingback', ip, agent: request.headers.get('user-agent') || '',
  });
  if (result instanceof Response) return result;
  return new Response('<methodResponse><params><param><value><string>OK</string></value></param></params></methodResponse>', { headers: { 'content-type': 'text/xml; charset=utf-8' } });
};

/**
 * Resolve a pingback target URL to a single published content row.
 *
 * The previous implementation loaded up to 1000 full content rows (body text
 * included) and compared permalinks in JS. Beyond 1000 published posts a
 * target silently stopped resolving — and the winner depended on D1's
 * unordered row order — while every call on this unauthenticated endpoint
 * cost a multi-megabyte read. Match the configured permalink patterns and do
 * one indexed lookup with the cid/slug captured from the URL instead.
 */
export async function resolvePingbackTarget(
  db: Database,
  options: SiteOptions,
  target: string,
): Promise<{ cid: number } | null> {
  let path: string;
  try {
    const targetUrl = new URL(target);
    const site = options.siteUrl ? new URL(options.siteUrl) : null;
    if (site && targetUrl.origin !== site.origin) return null;
    path = targetUrl.pathname;
  } catch {
    return null;
  }

  const attempts = [
    {
      kind: 'post' as const,
      pattern: (options.permalinkPattern as string | undefined) || DEFAULT_PERMALINK_PATTERNS.post,
      types: ['post'],
    },
    {
      kind: 'page' as const,
      pattern: (options.pagePattern as string | undefined) || DEFAULT_PERMALINK_PATTERNS.page,
      types: ['page'],
    },
  ];

  for (const attempt of attempts) {
    const regex = compilePermalinkPattern(attempt.pattern, attempt.kind);
    const match = regex ? path.match(regex) : null;
    if (!match?.groups) continue;

    const conditions = [
      eq(schema.contents.status, 'publish'),
      inArray(schema.contents.type, attempt.types),
      // A scheduled post's URL is not live yet: it must not accept pings.
      lte(schema.contents.created, nowSeconds()),
    ];
    if (match.groups.cid) {
      const cid = parseInt(match.groups.cid, 10);
      if (Number.isFinite(cid) && cid > 0) conditions.push(eq(schema.contents.cid, cid));
      else continue;
    } else if (match.groups.slug) {
      conditions.push(eq(schema.contents.slug, match.groups.slug));
    } else {
      continue;
    }

    const row = await db.query.contents.findFirst({ where: and(...conditions) });
    if (row) return { cid: row.cid };
  }

  return null;
}
