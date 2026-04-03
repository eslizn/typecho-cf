/**
 * Feed generator - RSS 2.0, RSS 1.0, and Atom 1.0
 * Corresponds to Typecho's Feed.php
 */

export interface FeedItem {
  title: string;
  link: string;
  content: string;
  excerpt?: string;
  date: Date;
  author?: string;
  categories?: string[];
  guid?: string;
}

export interface FeedConfig {
  title: string;
  description: string;
  link: string;
  feedUrl: string;
  language?: string;
  lastBuildDate?: Date;
}

/**
 * Generate RSS 2.0 feed
 */
export function generateRss2(config: FeedConfig, items: FeedItem[]): string {
  const lastBuild = config.lastBuildDate || new Date();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(config.title)}</title>
    <link>${escapeXml(config.link)}</link>
    <description>${escapeXml(config.description)}</description>
    <language>${config.language || 'zh-CN'}</language>
    <lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(config.feedUrl)}" rel="self" type="application/rss+xml"/>
    ${items.map((item) => `<item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid>${escapeXml(item.guid || item.link)}</guid>
      <pubDate>${item.date.toUTCString()}</pubDate>
      ${item.author ? `<dc:creator>${escapeXml(item.author)}</dc:creator>` : ''}
      ${(item.categories || []).map((c) => `<category>${escapeXml(c)}</category>`).join('\n      ')}
      <description>${escapeXml(item.excerpt || item.content)}</description>
      <content:encoded><![CDATA[${escapeCData(item.content)}]]></content:encoded>
    </item>`).join('\n    ')}
  </channel>
</rss>`;
}

/**
 * Generate Atom 1.0 feed
 */
export function generateAtom(config: FeedConfig, items: FeedItem[]): string {
  const updated = config.lastBuildDate || new Date();
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(config.title)}</title>
  <link href="${escapeXml(config.link)}"/>
  <link href="${escapeXml(config.feedUrl)}" rel="self"/>
  <id>${escapeXml(config.link)}</id>
  <updated>${updated.toISOString()}</updated>
  ${items.map((item) => `<entry>
    <title>${escapeXml(item.title)}</title>
    <link href="${escapeXml(item.link)}"/>
    <id>${escapeXml(item.guid || item.link)}</id>
    <published>${item.date.toISOString()}</published>
    <updated>${item.date.toISOString()}</updated>
    ${item.author ? `<author><name>${escapeXml(item.author)}</name></author>` : ''}
    ${(item.categories || []).map((c) => `<category term="${escapeXml(c)}"/>`).join('\n    ')}
    <content type="html"><![CDATA[${escapeCData(item.content)}]]></content>
  </entry>`).join('\n  ')}
</feed>`;
}

/**
 * Generate RSS 1.0 (RDF) feed
 */
export function generateRss1(config: FeedConfig, items: FeedItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel rdf:about="${escapeXml(config.feedUrl)}">
    <title>${escapeXml(config.title)}</title>
    <link>${escapeXml(config.link)}</link>
    <description>${escapeXml(config.description)}</description>
    <items>
      <rdf:Seq>
        ${items.map((item) => `<rdf:li rdf:resource="${escapeXml(item.link)}"/>`).join('\n        ')}
      </rdf:Seq>
    </items>
  </channel>
  ${items.map((item) => `<item rdf:about="${escapeXml(item.link)}">
    <title>${escapeXml(item.title)}</title>
    <link>${escapeXml(item.link)}</link>
    <dc:date>${item.date.toISOString()}</dc:date>
    ${item.author ? `<dc:creator>${escapeXml(item.author)}</dc:creator>` : ''}
    <description>${escapeXml(item.excerpt || item.content)}</description>
    <content:encoded><![CDATA[${escapeCData(item.content)}]]></content:encoded>
  </item>`).join('\n  ')}
</rdf:RDF>`;
}

function escapeCData(str: string): string {
  return str.replace(/]]>/g, ']]]]><![CDATA[>');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
