/**
 * Unit tests for src/lib/feed.ts
 *
 * Tests CDATA injection prevention, XML escaping, and feed format generation
 * for RSS 2.0, Atom 1.0, and RSS 1.0 feeds.
 */
import { describe, it, expect } from 'vitest';
import { generateRss2, generateAtom, generateRss1 } from '@/lib/feed';
import type { FeedConfig, FeedItem } from '@/lib/feed';

const baseConfig: FeedConfig = {
  title: 'Test Blog',
  description: 'A test blog',
  link: 'https://example.com',
  feedUrl: 'https://example.com/feed',
  language: 'zh-CN',
  lastBuildDate: new Date('2026-03-15T12:00:00Z'),
};

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: 'Test Post',
    link: 'https://example.com/post/1',
    content: '<p>Hello World</p>',
    date: new Date('2026-03-15T10:00:00Z'),
    author: 'Alice',
    categories: ['tech'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CDATA injection prevention
// ---------------------------------------------------------------------------
describe('CDATA injection prevention', () => {
  const maliciousContent = 'before ]]> <script>alert("xss")</script> after';

  it('RSS 2.0: escapes ]]> in CDATA content', () => {
    const xml = generateRss2(baseConfig, [makeItem({ content: maliciousContent })]);
    // The raw ]]> should NOT appear — it should be split into ]]]]><![CDATA[>
    expect(xml).not.toContain(']]> <script>');
    expect(xml).toContain(']]]]><![CDATA[>');
    // The CDATA structure should remain valid
    expect(xml).toContain('<![CDATA[');
  });

  it('Atom: escapes ]]> in CDATA content', () => {
    const xml = generateAtom(baseConfig, [makeItem({ content: maliciousContent })]);
    expect(xml).not.toContain(']]> <script>');
    expect(xml).toContain(']]]]><![CDATA[>');
  });

  it('RSS 1.0: escapes ]]> in CDATA content', () => {
    const xml = generateRss1(baseConfig, [makeItem({ content: maliciousContent })]);
    expect(xml).not.toContain(']]> <script>');
    expect(xml).toContain(']]]]><![CDATA[>');
  });

  it('handles content with multiple ]]> sequences', () => {
    const content = 'first ]]> middle ]]> last';
    const xml = generateRss2(baseConfig, [makeItem({ content })]);
    // Count occurrences of the escaped pattern
    const matches = xml.match(/\]\]\]\]><!\[CDATA\[>/g);
    expect(matches).toHaveLength(2);
  });

  it('leaves normal content unchanged in CDATA', () => {
    const normalContent = '<p>Normal <strong>HTML</strong> content</p>';
    const xml = generateRss2(baseConfig, [makeItem({ content: normalContent })]);
    expect(xml).toContain(`<![CDATA[${normalContent}]]>`);
  });
});

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------
describe('XML escaping in feeds', () => {
  it('escapes special characters in titles', () => {
    const xml = generateRss2(baseConfig, [makeItem({ title: 'Test & "quotes" <tags>' })]);
    expect(xml).toContain('Test &amp; &quot;quotes&quot; &lt;tags&gt;');
  });

  it('escapes special characters in config title', () => {
    const config = { ...baseConfig, title: 'Blog & More' };
    const xml = generateRss2(config, []);
    expect(xml).toContain('<title>Blog &amp; More</title>');
  });

  it('escapes author names', () => {
    const xml = generateRss2(baseConfig, [makeItem({ author: 'O\'Brien & Co' })]);
    expect(xml).toContain('O&apos;Brien &amp; Co');
  });

  it('escapes category names', () => {
    const xml = generateRss2(baseConfig, [makeItem({ categories: ['C++ & C#'] })]);
    expect(xml).toContain('C++ &amp; C#');
  });
});

// ---------------------------------------------------------------------------
// RSS 2.0 structure
// ---------------------------------------------------------------------------
describe('generateRss2()', () => {
  it('generates valid RSS 2.0 XML structure', () => {
    const xml = generateRss2(baseConfig, [makeItem()]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('<item>');
    expect(xml).toContain('</channel>');
    expect(xml).toContain('</rss>');
  });

  it('includes atom:link self reference', () => {
    const xml = generateRss2(baseConfig, []);
    expect(xml).toContain('rel="self"');
    expect(xml).toContain('type="application/rss+xml"');
  });

  it('handles empty items list', () => {
    const xml = generateRss2(baseConfig, []);
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });

  it('includes pubDate for items', () => {
    const xml = generateRss2(baseConfig, [makeItem()]);
    expect(xml).toContain('<pubDate>');
  });

  it('uses excerpt for description if available', () => {
    const xml = generateRss2(baseConfig, [makeItem({ excerpt: 'Short summary' })]);
    expect(xml).toContain('<description>Short summary</description>');
  });
});

// ---------------------------------------------------------------------------
// Atom 1.0 structure
// ---------------------------------------------------------------------------
describe('generateAtom()', () => {
  it('generates valid Atom 1.0 XML structure', () => {
    const xml = generateAtom(baseConfig, [makeItem()]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<entry>');
    expect(xml).toContain('</feed>');
  });

  it('includes self link', () => {
    const xml = generateAtom(baseConfig, []);
    expect(xml).toContain('rel="self"');
  });

  it('uses ISO 8601 date format', () => {
    const xml = generateAtom(baseConfig, [makeItem()]);
    expect(xml).toContain('<published>');
    expect(xml).toMatch(/<published>\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// RSS 1.0 (RDF) structure
// ---------------------------------------------------------------------------
describe('generateRss1()', () => {
  it('generates valid RSS 1.0 RDF structure', () => {
    const xml = generateRss1(baseConfig, [makeItem()]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rdf:RDF');
    expect(xml).toContain('</rdf:RDF>');
    expect(xml).toContain('<rdf:Seq>');
  });

  it('includes rdf:about on channel', () => {
    const xml = generateRss1(baseConfig, [makeItem()]);
    expect(xml).toContain(`rdf:about="`);
  });

  it('uses ISO 8601 dc:date format', () => {
    const xml = generateRss1(baseConfig, [makeItem()]);
    expect(xml).toContain('<dc:date>');
    expect(xml).toMatch(/<dc:date>\d{4}-\d{2}-\d{2}T/);
  });
});
