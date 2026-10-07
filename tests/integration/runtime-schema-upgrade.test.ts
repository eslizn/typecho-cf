import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import { ensureDatabaseReady, resetIsolateBoot } from '@/lib/isolate-boot';
import { resetFtsAvailability } from '@/lib/fulltext';
import { sql } from 'drizzle-orm';
import type { InValue } from '@libsql/client';

// Execute the runtime D1 bootstrap SQL against SQLite, including constraints
// and atomic batches. Stub-only boot tests cannot detect invalid SQL ordering.
function sqliteD1(db: TestDatabase): D1Database {
  const client = db.$client;
  function prepare(query: string, args: InValue[] = []) {
    return {
      sql: query,
      args,
      bind: (...values: InValue[]) => prepare(query, values),
      first: async () => (await client.execute({ sql: query, args })).rows[0] ?? null,
      all: async () => ({ results: (await client.execute({ sql: query, args })).rows }),
      run: async () => { await client.execute({ sql: query, args }); },
    };
  }
  return {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) =>
      client.batch(statements.map(statement => ({ sql: statement.sql, args: statement.args })), 'write'),
  } as unknown as D1Database;
}

let db: TestDatabase;
beforeEach(async () => {
  resetIsolateBoot();
  resetFtsAvailability();
  db = await createTestDb();
});
afterEach(async () => {
  db.$client.close();
  await disposeTestDb(db);
  resetIsolateBoot();
  resetFtsAvailability();
});

describe('legacy metadata schema upgrade', () => {
  it('merges overlapping relationships without violating their unique index', async () => {
    await db.run(sql`DROP INDEX typecho_metas_type_slug`);
    await db.run(sql`CREATE INDEX typecho_metas_type_slug ON typecho_metas(type, slug)`);
    await db.insert(schema.metas).values([
      { mid: 1, type: 'category', slug: 'news', count: 99 },
      { mid: 2, type: 'category', slug: 'news', count: 99 },
      { mid: 3, type: 'category', slug: 'child', parent: 2 },
      { mid: 4, type: 'tag', slug: 'news' },
    ]);
    await db.insert(schema.contents).values([
      { cid: 10, type: 'post' },
      { cid: 11, type: 'post' },
      { cid: 12, type: 'revision', parent: 10 },
    ]);
    await db.insert(schema.relationships).values([
      { cid: 10, mid: 1 }, { cid: 10, mid: 2 },
      { cid: 11, mid: 2 }, { cid: 12, mid: 2 },
      { cid: 10, mid: 4 },
    ]);
    await db.insert(schema.options).values({ name: 'defaultCategory', user: 0, value: '2' });

    await ensureDatabaseReady(sqliteD1(db));

    expect(await db.query.relationships.findMany()).toEqual(expect.arrayContaining([
      { cid: 10, mid: 1 }, { cid: 11, mid: 1 }, { cid: 12, mid: 1 }, { cid: 10, mid: 4 },
    ]));
    expect(await db.query.relationships.findMany()).toHaveLength(4);
    const metas = await db.query.metas.findMany();
    expect(metas.map(meta => meta.mid)).toEqual([1, 3, 4]);
    expect(metas.find(meta => meta.mid === 1)?.count).toBe(2);
    expect(metas.find(meta => meta.mid === 3)?.parent).toBe(1);
    expect(await db.query.options.findFirst({ where: sql`name = 'defaultCategory'` }))
      .toMatchObject({ value: '1' });
    expect(await db.query.options.findFirst({ where: sql`name = 'runtimeSchemaVersion'` }))
      .toMatchObject({ value: '20261007' });
    await expect(db.insert(schema.metas).values({ type: 'category', slug: 'news' })).rejects.toThrow();
  });

  it('repairs duplicate content slugs deterministically before enforcing uniqueness', async () => {
    await db.run(sql`DROP INDEX typecho_contents_slug_unique`);
    await db.run(sql`CREATE INDEX typecho_contents_slug_unique ON typecho_contents(slug)`);
    await db.insert(schema.contents).values([
      { cid: 11, type: 'page', slug: 'article' },
      { cid: 10, type: 'post', slug: 'article' },
      // This already-taken suffix must be preserved; cid 11 gets another stable suffix.
      { cid: 12, type: 'post_draft', slug: 'article-11' },
      { cid: 13, type: 'revision', slug: 'article', parent: 10 },
    ]);

    await ensureDatabaseReady(sqliteD1(db));

    const rows = await db.select({ cid: schema.contents.cid, slug: schema.contents.slug, type: schema.contents.type })
      .from(schema.contents);
    expect(rows).toEqual(expect.arrayContaining([
      { cid: 10, slug: 'article', type: 'post' },
      { cid: 11, slug: 'article-11-2', type: 'page' },
      { cid: 12, slug: 'article-11', type: 'post_draft' },
      { cid: 13, slug: 'article', type: 'revision' },
    ]));
    await expect(db.insert(schema.contents).values({ slug: 'article', type: 'attachment' })).rejects.toThrow();
    await db.insert(schema.contents).values({ slug: 'article', type: 'revision', parent: 10 });
  });
});
