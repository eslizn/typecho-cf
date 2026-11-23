import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { dedupeContentSlugs, mergeLegacyMetas } from '../../scripts/migrate';

function content(cid: number, slug: string | null, type = 'post') {
  return { cid, slug, type };
}

describe('dedupeContentSlugs()', () => {
  it('keeps the lowest cid slug and suffixes later collisions', () => {
    const rows = dedupeContentSlugs([
      content(7, 'duplicate'),
      content(3, 'duplicate'),
      content(5, 'other'),
    ]);

    expect(rows.map(row => [row.cid, row.slug])).toEqual([
      [3, 'duplicate'],
      [5, 'other'],
      [7, 'duplicate-7'],
    ]);
  });

  it('skips suffix values that another content already owns', () => {
    const rows = dedupeContentSlugs([
      content(1, 'article'),
      content(2, 'article'),
      content(3, 'article-2'),
    ]);

    expect(rows.map(row => [row.cid, row.slug])).toEqual([
      [1, 'article'],
      [2, 'article-2-2'],
      [3, 'article-2'],
    ]);
  });

  it('leaves revisions and null slugs untouched', () => {
    const rows = dedupeContentSlugs([
      content(1, 'hello'),
      content(2, 'hello', 'revision'),
      content(3, null),
      content(4, 'hello'),
    ]);

    expect(rows.map(row => [row.cid, row.slug])).toEqual([
      [1, 'hello'],
      [2, 'hello'],
      [3, null],
      [4, 'hello-4'],
    ]);
  });

  it('produces the same mapping regardless of source order', () => {
    const rows = [content(9, 'x'), content(4, 'x'), content(6, 'x-4')];
    const forward = dedupeContentSlugs(rows);
    const backward = dedupeContentSlugs([...rows].reverse());

    expect(forward).toEqual(backward);
  });
});

describe('migrated content rows', () => {
  let client: Client | undefined;

  afterEach(() => {
    client?.close();
    client = undefined;
  });

  it('survives INSERT OR REPLACE under the partial slug unique index', async () => {
    client = createClient({ url: ':memory:' });
    await client.execute(
      'CREATE TABLE typecho_contents (cid INTEGER PRIMARY KEY, slug TEXT, type TEXT, title TEXT)',
    );
    await client.execute(
      "CREATE UNIQUE INDEX typecho_contents_slug_unique ON typecho_contents (slug) " +
      "WHERE type IS NOT 'revision' AND slug IS NOT NULL",
    );

    // Legacy Typecho allows duplicate slugs; revisions may share their parent.
    const rows = dedupeContentSlugs([
      content(1, 'hello'),
      content(2, 'hello'),
      content(3, 'hello'),
      content(4, 'hello', 'revision'),
    ]);

    for (const row of rows) {
      await client.execute({
        sql: 'INSERT OR REPLACE INTO typecho_contents (cid, slug, type, title) VALUES (?, ?, ?, ?)',
        args: [row.cid, row.slug, row.type, `title-${row.cid}`],
      });
    }

    const result = await client.execute(
      'SELECT cid, slug FROM typecho_contents ORDER BY cid',
    );
    expect(result.rows.map(row => [row.cid, row.slug])).toEqual([
      [1, 'hello'],
      [2, 'hello-2'],
      [3, 'hello-3'],
      [4, 'hello'],
    ]);
  });
});


describe('mergeLegacyMetas', () => {
  it('keeps distinct term types and remaps duplicate term references before writing', () => {
    const result = mergeLegacyMetas([
      { mid: 9, type: 'category', slug: 'news', parent: 0, count: 3 },
      { mid: 2, type: 'category', slug: 'news', parent: 0, count: 99 },
      { mid: 8, type: 'tag', slug: 'news', parent: 0, count: 0 },
      { mid: 3, type: 'category', slug: 'child', parent: 9, count: 0 },
    ], [
      { cid: 1, mid: 9 }, { cid: 2, mid: 2 }, { cid: 2, mid: 9 }, { cid: 3, mid: 9 },
    ], [
      { name: 'defaultCategory', value: '9', user: 0 },
    ], [
      { cid: 1, type: 'post' }, { cid: 2, type: 'post' }, { cid: 3, type: 'revision' },
    ]);
    expect(result.metas).toEqual([
      { mid: 2, type: 'category', slug: 'news', parent: 0, count: 2 },
      { mid: 3, type: 'category', slug: 'child', parent: 2, count: 0 },
      { mid: 8, type: 'tag', slug: 'news', parent: 0, count: 0 },
    ]);
    expect(result.relationships).toEqual([{ cid: 1, mid: 2 }, { cid: 2, mid: 2 }, { cid: 3, mid: 2 }]);
    expect(result.options[0].value).toBe('2');
  });
});
