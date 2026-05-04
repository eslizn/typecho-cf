import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { buildPermalink } from '@/lib/content';
import { renderMarkdown, generateExcerpt } from '@/lib/markdown';
import { generateRss2, generateAtom, generateRss1 } from '@/lib/feed';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter } from '@/lib/plugin';
import { eq, and, desc, sql, or } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ locals, params }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);

  // Load activated plugins
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  const type = params.type || '';
  const isComments = type.includes('comments');
  const isAtom = type.startsWith('atom');
  const isRss1 = type.startsWith('rss');

  if (isComments) {
    return generateCommentsFeed(db, options, urls, isAtom, isRss1);
  }

  // Posts feed
  const posts = await db
    .select()
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        eq(schema.contents.allowFeed, '1'),
        sql`(${schema.contents.password} IS NULL OR ${schema.contents.password} = '')`
      )
    )
    .orderBy(desc(schema.contents.created))
    .limit(10);

  // Fetch authors
  const authorIds = [...new Set(posts.map((p) => p.authorId).filter(Boolean))];
  const authors = authorIds.length > 0
    ? await db.select().from(schema.users).where(sql`${schema.users.uid} IN (${sql.join(authorIds.map(id => sql`${id}`), sql`, `)})`)
    : [];
  const authorMap = new Map(authors.map((a) => [a.uid, a]));

  // Fetch categories
  const postIds = posts.map((p) => p.cid);
  const catData = postIds.length > 0
    ? await db
        .select({ cid: schema.relationships.cid, name: schema.metas.name })
        .from(schema.relationships)
        .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
        .where(
          and(
            sql`${schema.relationships.cid} IN (${sql.join(postIds.map(id => sql`${id}`), sql`, `)})`,
            eq(schema.metas.type, 'category')
          )
        )
    : [];
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
    language: 'zh-CN',
    lastBuildDate: posts[0] ? new Date((posts[0].created || 0) * 1000) : new Date(),
  };

  const items = [];
  for (const post of posts) {
    const author = authorMap.get(post.authorId || 0);
    const content = options.feedFullText ? renderMarkdown(post.text || '') : generateExcerpt(post.text || '');
    const cats = postCats.get(post.cid) || [];
    let item = {
      title: post.title || '无标题',
      link: buildPermalink(
        { cid: post.cid, slug: post.slug, type: post.type, created: post.created },
        urls.siteUrl,
        options.permalinkPattern as string | undefined,
      ),
      content,
      excerpt: generateExcerpt(post.text || ''),
      date: new Date((post.created || 0) * 1000),
      author: author?.screenName || author?.name || undefined,
      categories: cats,
    };
    // Apply feed:item filter — plugins can modify each feed item
    item = await applyFilter('feed:item', item);
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

  return new Response(xml, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, s-maxage=1800', // 30 min edge cache for feeds
    },
  });
};

async function generateCommentsFeed(
  db: ReturnType<typeof getDb>,
  options: any,
  urls: any,
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
    title: `${options.title} - 最近的评论`,
    description: `${options.title} 上的最近评论`,
    link: urls.siteUrl,
    feedUrl: isAtom ? urls.commentsFeedAtomUrl : isRss1 ? urls.commentsFeedRssUrl : urls.commentsFeedUrl,
    language: 'zh-CN',
    lastBuildDate: recentRows[0] ? new Date((recentRows[0].comment.created || 0) * 1000) : new Date(),
  };

  const items = recentRows.map(({ comment, content }) => ({
    title: `${comment.author || '匿名'} 的评论`,
    link: `${buildPermalink(
      { cid: content.cid, slug: content.slug, type: content.type, created: content.created },
      urls.siteUrl,
      options.permalinkPattern as string | undefined,
      options.pagePattern as string | undefined,
    )}#comment-${comment.coid}`,
    content: renderMarkdown(comment.text || ''),
    date: new Date((comment.created || 0) * 1000),
    author: comment.author || '匿名',
  }));

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

  return new Response(xml, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, s-maxage=1800', // 30 min edge cache for comment feeds
    },
  });
}
