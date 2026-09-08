/**
 * SEO metadata builders for Open Graph, Twitter Card, canonical, and description.
 *
 * Decision #23: Canonical + description + OG + Twitter Card only (no JSON-LD).
 */

import type { I18n } from '@/lib/i18n';

export interface SeoProps {
  canonical: string;
  description?: string;
  og?: {
    type?: 'website' | 'article';
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    site_name?: string;
  };
  twitter?: {
    card?: 'summary' | 'summary_large_image';
    title?: string;
    description?: string;
    image?: string;
  };
}

export interface SeoBuildContext {
  siteUrl: string;
  siteTitle: string;
  siteDescription: string;
  siteLogo?: string;
  i18n?: I18n;
}

function firstImageUrl(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const m = html.match(/<img[^>]+src="([^"]+)"/);
  return m ? m[1] : undefined;
}

function truncate(s: string | null | undefined, len: number): string | undefined {
  if (!s) return undefined;
  return s.length <= len ? s : s.slice(0, len - 1) + '…';
}

/** Build SEO for a single post/page (article). */
export function buildPostSeo(
  row: { cid: number; slug: string | null; type: string | null; created: number | null; title: string | null; text?: string | null },
  permalink: string,
  ctx: SeoBuildContext,
): SeoProps {
  const title = row.title || ctx.siteTitle;
  const desc = truncate(row.text, 200);
  const img = firstImageUrl(row.text) || ctx.siteLogo;

  return {
    canonical: permalink,
    description: desc,
    og: {
      type: 'article',
      title,
      description: desc,
      image: img,
      url: permalink,
      site_name: ctx.siteTitle,
    },
    twitter: {
      card: img ? 'summary_large_image' : 'summary',
      title,
      description: desc,
      image: img,
    },
  };
}

/** Build SEO for the homepage. */
export function buildIndexSeo(ctx: SeoBuildContext): SeoProps {
  return {
    canonical: ctx.siteUrl,
    description: ctx.siteDescription,
    og: {
      type: 'website',
      title: ctx.siteTitle,
      description: ctx.siteDescription,
      image: ctx.siteLogo,
      url: ctx.siteUrl,
      site_name: ctx.siteTitle,
    },
  };
}

/** Build SEO for archive pages (category, tag, author, search). */
export function buildArchiveSeo(
  kind: string,
  name: string,
  pageUrl: string,
  ctx: SeoBuildContext,
): SeoProps {
  const title = `${name} - ${ctx.siteTitle}`;
  return {
    canonical: pageUrl,
    description: ctx.i18n?.t(
      'core.seo.archiveDescription',
      { kind, name },
      'Browse the {kind} archive for "{name}".',
    ) ?? `Browse the ${kind} archive for "${name}".`,
    og: {
      type: 'website',
      title,
      url: pageUrl,
      site_name: ctx.siteTitle,
    },
  };
}
