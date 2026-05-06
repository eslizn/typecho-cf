import { eq, and } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { generateRandomString } from '@/lib/auth';
import { getCachedOptions, setCachedOptions } from '@/lib/cache';

export interface SiteOptions {
  theme: string;
  timezone: number;
  lang: string;
  charset: string;
  contentType: string;
  title: string;
  description: string;
  keywords: string;
  siteUrl: string;
  frontPage: string;
  frontArchive: number;
  pageSize: number;
  postsListSize: number;
  commentsListSize: number;
  postDateFormat: string;
  commentDateFormat: string;
  defaultCategory: number;
  allowRegister: number;
  defaultAllowComment: number;
  defaultAllowPing: number;
  defaultAllowFeed: number;
  feedFullText: number;
  markdown: number;
  commentsRequireMail: number;
  commentsRequireURL: number;
  commentsRequireModeration: number;
  commentsWhitelist: number;
  commentsMaxNestingLevels: number;
  commentsPostTimeout: number;
  commentsUrlNofollow: number;
  commentsShowUrl: number;
  commentsMarkdown: number;
  commentsPageBreak: number;
  commentsThreaded: number;
  commentsPageSize: number;
  commentsPageDisplay: string;
  commentsOrder: string;
  commentsCheckReferer: number;
  commentsAutoClose: number;
  commentsPostIntervalEnable: number;
  commentsPostInterval: number;
  commentsShowCommentOnly: number;
  commentsAvatar: number;
  commentsAvatarRating: string;
  commentsAntiSpam: number;
  commentsHTMLTagAllowed: string | null;
  attachmentTypes: string;
  secret: string;
  installed: number;
  allowXmlRpc: number;
  editorSize: number;
  autoSave: number;
  xmlrpcMarkdown: number;
  cacheEnabled: number;
  cacheVersion: number;
  activatedPlugins: string;
  permalinkPattern: string;
  pagePattern: string;
  categoryPattern: string;
  [key: string]: string | number | null | undefined;
}

const defaultOptions: Partial<SiteOptions> = {
  theme: 'typecho-theme-minimal',
  timezone: 28800,
  lang: 'zh_CN',
  charset: 'UTF-8',
  contentType: 'text/html',
  title: 'Hello World',
  description: 'Your description here.',
  keywords: 'typecho,blog',
  frontPage: 'recent',
  frontArchive: 0,
  pageSize: 5,
  postsListSize: 10,
  commentsListSize: 10,
  postDateFormat: 'Y-m-d',
  commentDateFormat: 'F jS, Y',
  defaultCategory: 1,
  allowRegister: 0,
  defaultAllowComment: 1,
  defaultAllowPing: 1,
  defaultAllowFeed: 1,
  feedFullText: 1,
  markdown: 1,
  commentsRequireMail: 1,
  commentsRequireURL: 0,
  commentsRequireModeration: 0,
  commentsWhitelist: 0,
  commentsMaxNestingLevels: 5,
  commentsPostTimeout: 24 * 3600 * 30,
  commentsUrlNofollow: 1,
  commentsShowUrl: 1,
  commentsMarkdown: 0,
  commentsPageBreak: 0,
  commentsThreaded: 1,
  commentsPageSize: 20,
  commentsPageDisplay: 'last',
  commentsOrder: 'ASC',
  commentsCheckReferer: 1,
  commentsAutoClose: 0,
  commentsPostIntervalEnable: 1,
  commentsPostInterval: 60,
  commentsShowCommentOnly: 0,
  commentsAvatar: 1,
  commentsAvatarRating: 'G',
  commentsAntiSpam: 1,
  commentsHTMLTagAllowed: null,
  attachmentTypes: '@image@',
  cacheEnabled: 1,
  cacheVersion: 0,
  installed: 0,
  allowXmlRpc: 2,
  editorSize: 350,
  autoSave: 0,
  xmlrpcMarkdown: 0,
};

/**
 * Load all global options from database (with Cache API caching)
 */
export async function loadOptions(db: Database): Promise<SiteOptions> {
  // Try cache first
  const cached = await getCachedOptions();
  if (cached) {
    return cached as unknown as SiteOptions;
  }

  const rows = await db
    .select()
    .from(schema.options)
    .where(eq(schema.options.user, 0));

  const opts: Record<string, string | number | null | undefined> = { ...defaultOptions };
  for (const row of rows) {
    opts[row.name] = row.value;
  }

  // Parse numeric values
  const numericKeys = [
    'timezone', 'frontArchive', 'pageSize', 'postsListSize',
    'commentsListSize', 'defaultCategory', 'allowRegister', 'defaultAllowComment',
    'defaultAllowPing', 'defaultAllowFeed', 'feedFullText', 'markdown',
    'commentsRequireMail', 'commentsRequireURL', 'commentsRequireModeration',
    'commentsWhitelist', 'commentsMaxNestingLevels', 'commentsPostTimeout',
    'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
    'commentsPageBreak', 'commentsThreaded', 'commentsPageSize',
    'commentsCheckReferer', 'commentsAutoClose', 'commentsPostIntervalEnable',
    'commentsPostInterval', 'commentsShowCommentOnly', 'commentsAvatar',
    'commentsAntiSpam', 'installed', 'allowXmlRpc', 'editorSize', 'autoSave',
    'xmlrpcMarkdown', 'gzip', 'cacheEnabled', 'cacheVersion',
  ];

  for (const key of numericKeys) {
    if (typeof opts[key] === 'string') {
      opts[key] = parseInt(opts[key] as string, 10) || 0;
    }
  }

  // Auto-generate secret if missing (e.g. migrated from PHP Typecho where secret is in config.inc.php)
  if (!opts.secret) {
    const secret = generateRandomString(32);
    opts.secret = secret;
    // Persist to DB so it stays consistent across requests
    await setOption(db, 'secret', secret);
  }

  // Write to cache for subsequent requests
  await setCachedOptions(opts);

  return opts as unknown as SiteOptions;
}

/**
 * Get a single option value
 */
export async function getOption(db: Database, name: string, userId = 0): Promise<string | null> {
  const row = await db.query.options.findFirst({
    where: and(eq(schema.options.name, name), eq(schema.options.user, userId)),
  });
  return row?.value ?? null;
}

/**
 * Set an option value
 */
export async function setOption(db: Database, name: string, value: string, userId = 0): Promise<void> {
  await db
    .insert(schema.options)
    .values({ name, user: userId, value })
    .onConflictDoUpdate({
      target: [schema.options.name, schema.options.user],
      set: { value },
    });
}

/**
 * Delete an option
 */
export async function deleteOption(db: Database, name: string, userId = 0): Promise<void> {
  await db
    .delete(schema.options)
    .where(and(eq(schema.options.name, name), eq(schema.options.user, userId)));
}

/**
 * Compute derived URLs from options
 */
export function computeUrls(opts: SiteOptions) {
  const siteUrl = opts.siteUrl?.replace(/\/$/, '') || '';
  return {
    siteUrl,
    adminUrl: `${siteUrl}/admin/`,
    loginUrl: `${siteUrl}/admin/login`,
    logoutUrl: `${siteUrl}/api/users/logout`,
    profileUrl: `${siteUrl}/admin/profile`,
    feedUrl: `${siteUrl}/feed`,
    feedRssUrl: `${siteUrl}/feed/rss`,
    feedAtomUrl: `${siteUrl}/feed/atom`,
    commentsFeedUrl: `${siteUrl}/feed/comments`,
    commentsFeedRssUrl: `${siteUrl}/feed/rss/comments`,
    commentsFeedAtomUrl: `${siteUrl}/feed/atom/comments`,
    xmlRpcUrl: `${siteUrl}/api/xmlrpc`,
    themeUrl: (file: string) => `${siteUrl}/themes/${opts.theme}/${file}`,
  };
}
