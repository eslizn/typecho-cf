/**
 * Shared utilities for feed generation — used by the main feed route and
 * sub-channel feeds (category / tag / author).
 */

import type { FeedItem } from '@/lib/feed';
import type { I18n, ResolvedLocale } from '@/lib/i18n';
import { createRequestI18n } from '@/lib/i18n-runtime';
import { buildPermalink } from '@/lib/content';
import { generateRss2, generateAtom, generateRss1 } from '@/lib/feed';
import { renderContent } from '@/lib/markdown';
import {
  applyFilterSafely,
  parseActivatedPlugins,
  loadPluginConfig,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { getDb } from '@/db';
import { computeUrls, loadOptions } from '@/lib/options';
import { getRequestCoreContextFromLocals } from '@/lib/context';
import { env } from 'cloudflare:workers';
import { createCapabilityRuntimeContext } from '@/lib/capability';

export const FEED_ITEMS_DEFAULT = 10;
export const FEED_ITEMS_MIN = 5;
export const FEED_ITEMS_MAX = 50;

export function clampFeedItems(rawValue: unknown): number {
  const n = parseInt(String(rawValue ?? FEED_ITEMS_DEFAULT), 10) || FEED_ITEMS_DEFAULT;
  return Math.min(FEED_ITEMS_MAX, Math.max(FEED_ITEMS_MIN, n));
}

export async function getFeedRuntime(locals: App.Locals, request?: Request) {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx: HookContext = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  const urls = computeUrls(options);
  if (!core) {
    await setActivatedPlugins(
      pluginCtx,
      parseActivatedPlugins(options.activatedPlugins as string | undefined),
    );
    pluginCtx.capabilityRuntime = createCapabilityRuntimeContext({
      request: request || new Request(urls.feedUrl || 'http://localhost/feed'),
      db,
      options,
      env: env as unknown as Record<string, unknown>,
      activatedPlugins: pluginCtx.activatedPlugins,
      activationGeneration: pluginCtx.activationGeneration,
      getPluginConfig: pluginId => loadPluginConfig(options, pluginId),
    });
  }
  const runtime = core?.i18n && core.resolvedLocale
    ? { i18n: core.i18n, resolvedLocale: core.resolvedLocale, autoLocale: core.autoLocale }
    : createRequestI18n(
        typeof options.lang === 'string' ? options.lang : 'zh_CN',
        request || new Request(urls.feedUrl || 'http://localhost/feed'),
        pluginCtx.activatedPlugins,
      );
  return { db, options, urls, pluginCtx, ...runtime };
}

export async function buildFeedItem(
  post: { cid: number; slug: string | null; type: string | null; created: number | null; title: string | null; text?: string | null },
  siteUrl: string,
  permalinkPattern: string | undefined,
  pagePattern: string | undefined,
  pluginCtx: HookContext,
  feedFullText?: boolean,
  i18n?: I18n,
): Promise<FeedItem> {
  const rendered = renderContent(post.text || '');
  const link = buildPermalink(post, siteUrl, permalinkPattern, pagePattern);

  let item: FeedItem = {
    title: post.title || i18n?.t('feed.untitled', {}, 'Untitled') || 'Untitled',
    link,
    content: feedFullText ? rendered.html : '',
    excerpt: rendered.plainExcerpt,
    date: new Date((post.created || 0) * 1000),
  };

  item = await applyFilterSafely(pluginCtx, 'feed:item', item, { i18n, capabilityRuntime: pluginCtx.capabilityRuntime });
  return item;
}

/**
 * Apply the complete-feed filter after the XML document has been generated.
 * Keeping this in the shared helper makes category/tag/author feeds follow
 * the same lifecycle as the main feed route.
 */
export async function renderFeedResponse(
  pluginCtx: HookContext,
  xml: string,
  contentType: string,
  extra: Record<string, unknown>,
): Promise<Response> {
  const filteredXml = await applyFilterSafely(pluginCtx, 'feed:render', xml, {
    ...extra,
    capabilityRuntime: extra.capabilityRuntime ?? pluginCtx.capabilityRuntime,
  });
  const response = xmlResponse(typeof filteredXml === 'string' ? filteredXml : xml, contentType);
  if (extra.autoLocale === true) response.headers.set('Vary', 'Accept-Language');
  return response;
}

export function xmlResponse(xml: string, contentType: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, s-maxage=1800',
    },
  });
}
