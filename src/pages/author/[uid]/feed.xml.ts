import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { generateRss2 } from '@/lib/feed';
import { clampFeedItems, buildFeedItem, getFeedRuntime, renderFeedResponse } from '@/lib/feed-helpers';
import { eq, and, desc } from 'drizzle-orm';
import { publishedPostCondition } from '@/lib/content-visibility';

export const GET: APIRoute = async ({ request, locals, params }) => {
  const uid = parseInt(params.uid || '0', 10);
  if (!uid) return new Response('Not Found', { status: 404 });

  const { db, options, urls, pluginCtx } = await getFeedRuntime(locals);

  const author = await db.query.users.findFirst({
    columns: { name: true, screenName: true },
    where: eq(schema.users.uid, uid),
  });
  if (!author) return new Response('Not Found', { status: 404 });

  const limit = clampFeedItems(options.feedItems);
  const posts = await db
    .select()
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.authorId, uid),
        publishedPostCondition(),
        eq(schema.contents.allowFeed, '1'),
      ),
    )
    .orderBy(desc(schema.contents.created))
    .limit(limit);

  const items = [];
  for (const p of posts) {
    items.push(
      await buildFeedItem(p, urls.siteUrl, options.permalinkPattern as string | undefined, undefined, pluginCtx, !!(options.feedFullText)),
    );
  }

  const displayName = author.screenName || author.name || `用户${uid}`;
  const config = { title: `${options.title} - 作者：${displayName}`, link: `${urls.siteUrl}/author/${uid}/`, description: '', feedUrl: urls.siteUrl, language: 'zh-CN', lastBuildDate: items[0]?.date || new Date() };
  return renderFeedResponse(
    pluginCtx,
    generateRss2(config, items),
    'application/rss+xml; charset=utf-8',
    { requestUrl: new URL(request.url), type: params.uid || '', options, urls },
  );
};
