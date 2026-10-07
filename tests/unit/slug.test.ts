import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { resolveUniqueContentSlug, resolveUniqueMetaSlug, writeWithUniqueContentSlug } from '@/lib/slug';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let db: TestDatabase;

beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await disposeTestDb(db); });

describe('slug namespace resolution', () => {
  it('normalizes unsafe content slugs and uses the current cid suffix on conflict', async () => {
    await db.insert(schema.contents).values({
      title: 'one', slug: 'hello-world', type: 'post', status: 'publish', authorId: 1,
    });
    expect(await resolveUniqueContentSlug(db as any, ' Hello / World?# ', 22))
      .toBe('hello-world-22');
  });

  it('does not overwrite a pre-existing cid suffix while resolving a conflict', async () => {
    await db.insert(schema.contents).values([
      { title: 'Base', slug: 'article', type: 'post' },
      { title: 'Taken suffix', slug: 'article-22', type: 'page' },
    ]);
    expect(await resolveUniqueContentSlug(db as any, 'article', 22)).toBe('article-22-2');
  });

  it('enforces uniqueness for every non-revision type while allowing revision slug reuse', async () => {
    const [post] = await db.insert(schema.contents).values({ slug: 'shared', type: 'post' }).returning();
    await db.insert(schema.contents).values({ slug: 'shared', type: 'revision', parent: post.cid });
    await expect(db.insert(schema.contents).values({ slug: 'shared', type: 'page' })).rejects.toThrow();
  });

  it('resolves simultaneous slug writers to distinct final URLs', async () => {
    const [first, second] = await db.insert(schema.contents).values([
      { slug: 'temporary-one', type: 'post' },
      { slug: 'temporary-two', type: 'page' },
    ]).returning({ cid: schema.contents.cid });
    let writers = 0;
    let release!: () => void;
    const bothResolved = new Promise<void>(resolve => { release = resolve; });
    const write = (cid: number) => writeWithUniqueContentSlug(db as any, 'racing-url', cid, async (slug) => {
      if (++writers <= 2) {
        if (writers === 2) release();
        await bothResolved;
      }
      await db.update(schema.contents).set({ slug }).where(eq(schema.contents.cid, cid));
      return slug;
    });
    const finalSlugs = await Promise.all([write(first.cid), write(second.cid)]);
    expect(new Set(finalSlugs).size).toBe(2);
    expect(finalSlugs).toContain('racing-url');
    expect(finalSlugs).toContain(`racing-url-${finalSlugs[0] === 'racing-url' ? second.cid : first.cid}`);
    expect(await db.select({ slug: schema.contents.slug }).from(schema.contents)
      .where(eq(schema.contents.slug, 'racing-url'))).toHaveLength(1);
  });

  it('does not retry write failures outside the content slug constraint', async () => {
    const write = vi.fn(async () => { throw new Error('database unavailable'); });
    await expect(writeWithUniqueContentSlug(db as any, 'ordinary-url', 44, write))
      .rejects.toThrow('database unavailable');
    expect(write).toHaveBeenCalledOnce();
  });

  it('resolves metadata conflicts only within the same type namespace', async () => {
    await db.insert(schema.metas).values([
      { name: 'Category', slug: 'news', type: 'category' },
      { name: 'Tag', slug: 'news', type: 'tag' },
    ]);
    expect(await resolveUniqueMetaSlug(db as any, 'News', 'category', 0, 'category'))
      .toBe('news-2');
    expect(await resolveUniqueMetaSlug(db as any, 'News', 'tag', 0, 'tag'))
      .toBe('news-2');
    expect(await resolveUniqueMetaSlug(db as any, 'Fresh', 'tag', 0, 'tag'))
      .toBe('fresh');
  });
});
