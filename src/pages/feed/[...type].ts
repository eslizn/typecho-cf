import type { APIRoute } from 'astro';
import { schema, type Database } from '@/db';
import { buildPermalink } from '@/lib/content';
import { renderContent } from '@/lib/markdown';
import { generateRss2, generateAtom, generateRss1, type FeedItem } from '@/lib/feed';
import { applyFilterSafely } from '@/lib/plugin';
import { getFeedRuntime, renderFeedResponse } from '@/lib/feed-helpers';
import { eq, and, desc, sql, or } from 'drizzle-orm';
import { publishedPostCondition } from '@/lib/content-visibility';

const FEED_ITEMS_DEFAULT = 10;
const FEED_ITEMS_MIN = 5;
const FEED_ITEMS_MAX = 50;

export const GET: APIRoute = async ({ request, locals, params }) => {
  const { db, options, urls, pluginCtx, i18n, autoLocale } = await getFeedRuntime(locals, request);

  const type = params.type || '';
  const isComments = type.includes('comments');
  const isAtom = type.startsWith('atom');
  const isRss1 = type.startsWith('rss');

  if (isComments) {
    return generateCommentsFeed(db, options, urls, pluginCtx, i18n, autoLocale, isAtom, isRss1);
  }

  // Posts feed
  // G7-7: feed limit is configurable via options.feedItems with
  // sensible bounds so admins can tune for slow clients without
  // letting a typo blow the response into the megabytes.
  const feedLimit = Math.min(
    FEED_ITEMS_MAX,
    Math.max(
      FEED_ITEMS_MIN,
      parseInt(String(options.feedItems ?? FEED_ITEMS_DEFAULT), 10) || FEED_ITEMS_DEFAULT,
    ),
  );
  const posts = await db
    .select()
    .from(schema.contents)
    .where(
      and(
        publishedPostCondition(),
        eq(schema.contents.allowFeed, '1'),
        sql`(${schema.contents.password} IS NULL OR ${schema.contents.password} = '')`,
      ),
    )
    .orderBy(desc(schema.contents.created))
    .limit(feedLimit);

  // Fetch authors and categories in one D1 round trip.
  const authorIds = [...new Set(posts.map((p) => p.authorId).filter(Boolean))];
  const postIds = posts.map((p) => p.cid);
  const [authors, catData] = postIds.length > 0
    ? await db.batch([
        db
          .select({
            uid: schema.users.uid,
            name: schema.users.name,
            screenName: schema.users.screenName,
          })
          .from(schema.users)
          .where(sql`${schema.users.uid} IN (${sql.join(authorIds.map(id => sql`${id}`), sql`, `)})`),
        db
        .select({ cid: schema.relationships.cid, name: schema.metas.name })
        .from(schema.relationships)
        .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
        .where(
          and(
            sql`${schema.relationships.cid} IN (${sql.join(postIds.map(id => sql`${id}`), sql`, `)})`,
            eq(schema.metas.type, 'category')
          )
        ),
      ])
    : [[], []];
  const authorMap = new Map(authors.map((a) => [a.uid, a]));
  const postCats = new Map<number, string[]>();
  for (const row of catData) {
    if (!postCats.has(row.cid)) postCats.set(row.cid, []);
    if (row.name) postCats.get(row.cid)!.push(row.name);
  }

  const config = {
    title: options.title,
    description: options.description,
    link: urls.siteUrl,
    feedUrl: isAtom ? urls.feedAtomUrl : isRss1 ? urls.feedRssUrl : urls.feedUrl,
    i18n,
    lastBuildDate: posts[0] ? new Date((posts[0].created || 0) * 1000) : new Date(),
  };

  const items: FeedItem[] = [];
  for (const post of posts) {
    const author = authorMap.get(post.authorId || 0);
    // G7-6: distinguish description (always the excerpt) from
    // content:encoded (full body, only when feedFullText is on). The
    // legacy code emitted the full body in both fields when feedFullText
    // was enabled, doubling the payload.
    const rendered = renderContent(post.text || '');
    const cats = postCats.get(post.cid) || [];
    let item: FeedItem = {
      title: post.title || i18n.t('feed.untitled', {}, 'Untitled'),
      link: buildPermalink(
        { cid: post.cid, slug: post.slug, type: post.type, created: post.created },
        urls.siteUrl,
        options.permalinkPattern as string | undefined,
      ),
      content: options.feedFullText ? rendered.html : '',
      excerpt: rendered.plainExcerpt,
      date: new Date((post.created || 0) * 1000),
      author: author?.screenName || author?.name || undefined,
      categories: cats,
    };
    // Apply feed:item filter — plugins can modify each feed item
    item = await applyFilterSafely(pluginCtx, 'feed:item', item, { i18n, capabilityRuntime: pluginCtx.capabilityRuntime });
    items.push(item);
  }

  let xml: string;
  let contentType: string;

  if (isAtom) {
    xml = generateAtom(config, items);
    contentType = 'application/atom+xml; charset=utf-8';
  } else if (isRss1) {
    xml = generateRss1(config, items);
    contentType = 'application/rdf+xml; charset=utf-8';
  } else {
    xml = generateRss2(config, items);
    contentType = 'application/rss+xml; charset=utf-8';
  }

  return renderFeedResponse(pluginCtx, xml, contentType, {
    requestUrl: new URL(request?.url || urls.feedUrl || urls.siteUrl || 'http://localhost/'),
    type,
    options,
    urls,
    i18n,
    autoLocale,
    capabilityRuntime: pluginCtx.capabilityRuntime,
  });
};

async function generateCommentsFeed(
  db: Database,
  options: any,
  urls: any,
  pluginCtx: Parameters<typeof applyFilterSafely>[0],
  i18n: import('@/lib/i18n').I18n,
  autoLocale: boolean,
  isAtom: boolean,
  isRss1: boolean
) {
  const recentRows = await db
    .select({ comment: schema.comments, content: schema.contents })
    .from(schema.comments)
    .innerJoin(schema.contents, eq(schema.comments.cid, schema.contents.cid))
    .where(and(
      eq(schema.comments.status, 'approved'),
      eq(schema.contents.status, 'publish'),
      eq(schema.contents.allowFeed, '1'),
      or(eq(schema.contents.type, 'post'), eq(schema.contents.type, 'page')),
      sql`(${schema.contents.password} IS NULL OR ${schema.contents.password} = '')`,
    ))
    .orderBy(desc(schema.comments.created))
    .limit(10);

  const config = {
    title: i18n.t('feed.comments.title', { siteTitle: options.title }, `${options.title} - Recent comments`),
    description: i18n.t('feed.comments.description', { siteTitle: options.title }, `Recent comments on ${options.title}`),
    link: urls.siteUrl,
    feedUrl: isAtom ? urls.commentsFeedAtomUrl : isRss1 ? urls.commentsFeedRssUrl : urls.commentsFeedUrl,
    i18n,
    lastBuildDate: recentRows[0] ? new Date((recentRows[0].comment.created || 0) * 1000) : new Date(),
  };

  const items: FeedItem[] = [];
  for (const { comment, content } of recentRows) {
    let item: FeedItem = {
    title: i18n.t('feed.comment.title', { author: comment.author || i18n.t('feed.anonymous', {}, 'Anonymous') }, `${comment.author || 'Anonymous'}'s comment`),
    link: `${buildPermalink(
      { cid: content.cid, slug: content.slug, type: content.type, created: content.created },
      urls.siteUrl,
      options.permalinkPattern as string | undefined,
      options.pagePattern as string | undefined,
    )}#comment-${comment.coid}`,
    content: renderContent(comment.text || '').html,
    date: new Date((comment.created || 0) * 1000),
    author: comment.author || i18n.t('feed.anonymous', {}, 'Anonymous'),
    };
    item = await applyFilterSafely(pluginCtx, 'feed:item', item, { i18n, capabilityRuntime: pluginCtx.capabilityRuntime });
    items.push(item);
  }

  let xml: string;
  let contentType: string;

  if (isAtom) {
    xml = generateAtom(config, items);
    contentType = 'application/atom+xml; charset=utf-8';
  } else if (isRss1) {
    xml = generateRss1(config, items);
    contentType = 'application/rdf+xml; charset=utf-8';
  } else {
    xml = generateRss2(config, items);
    contentType = 'application/rss+xml; charset=utf-8';
  }

  return renderFeedResponse(pluginCtx, xml, contentType, {
    requestUrl: urls.commentsFeedUrl,
    type: 'comments',
    options,
    urls,
    i18n,
    autoLocale,
    capabilityRuntime: pluginCtx.capabilityRuntime,
  });
}
