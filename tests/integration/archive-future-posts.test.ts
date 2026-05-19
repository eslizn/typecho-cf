/**
 * G7-5 regression: every archive (index, category, tag, author) must
 * hide posts whose `created` is in the future. The legacy code only
 * filtered the index page, leaking scheduled posts via secondary
 * archives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import {
  prepareIndexData,
  prepareCategoryData,
  prepareTagData,
  prepareAuthorData,
} from '@/lib/page-data';

const NOW = Math.floor(Date.now() / 1000);
const PAST = NOW - 86400;       // yesterday
const FUTURE = NOW + 86400;     // tomorrow

async function seedArchive() {
  // Author
  await testDb.insert(schema.users).values({
    name: 'alice', mail: 'alice@example.com', group: 'editor', authCode: 'x',
  });
  const author = (await testDb.query.users.findFirst())!;

  // Category + tag
  await testDb.insert(schema.metas).values({
    name: 'Tech', slug: 'tech', type: 'category', count: 0, order: 1,
  });
  const category = (await testDb.query.metas.findFirst({
    where: (t, { eq }) => eq(t.slug, 'tech'),
  }))!;
  await testDb.insert(schema.metas).values({
    name: 'astro', slug: 'astro', type: 'tag', count: 0, order: 1,
  });
  const tag = (await testDb.query.metas.findFirst({
    where: (t, { eq }) => eq(t.slug, 'astro'),
  }))!;

  // Past + future posts (both publish), both attached to category & tag
  for (const { slug, created, title } of [
    { slug: 'past-post', created: PAST, title: 'Past Post' },
    { slug: 'future-post', created: FUTURE, title: 'Future Post' },
  ]) {
    await testDb.insert(schema.contents).values({
      title, slug, type: 'post', status: 'publish', authorId: author.uid, created, modified: created,
    });
    const post = (await testDb.query.contents.findFirst({
      where: (t, { eq }) => eq(t.slug, slug),
    }))!;
    await testDb.insert(schema.relationships).values({ cid: post.cid, mid: category.mid });
    await testDb.insert(schema.relationships).values({ cid: post.cid, mid: tag.mid });
  }

  return { author, category, tag };
}

function buildCtx() {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      pageSize: 10,
      categoryPattern: '/category/{slug}/',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      commentsAvatarRating: 'G',
      commentsOrder: 'ASC',
      timezone: 0,
      commentsAntiSpam: 0,
      secret: '',
    } as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
  };
}

describe('archive future-post filtering (G7-5)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('index hides future posts', async () => {
    await seedArchive();
    const ctx = buildCtx();
    const props = await prepareIndexData(ctx as any, 'https://example.com/', {}, new URL('https://example.com/'));
    const titles = props.posts.map((p: any) => p.title);
    expect(titles).toContain('Past Post');
    expect(titles).not.toContain('Future Post');
  });

  it('category archive hides future posts', async () => {
    await seedArchive();
    const ctx = buildCtx();
    const result = await prepareCategoryData(ctx as any, 'tech', 'https://example.com/category/tech/', {}, new URL('https://example.com/category/tech/'));
    if ('posts' in result) {
      const titles = result.posts.map((p: any) => p.title);
      expect(titles).toContain('Past Post');
      expect(titles).not.toContain('Future Post');
    } else {
      throw new Error('expected ThemeArchiveProps');
    }
  });

  it('tag archive hides future posts', async () => {
    await seedArchive();
    const ctx = buildCtx();
    const result = await prepareTagData(ctx as any, 'astro', 'https://example.com/tag/astro/', {}, new URL('https://example.com/tag/astro/'));
    if ('posts' in result) {
      const titles = result.posts.map((p: any) => p.title);
      expect(titles).toContain('Past Post');
      expect(titles).not.toContain('Future Post');
    } else {
      throw new Error('expected ThemeArchiveProps');
    }
  });

  it('author archive hides future posts', async () => {
    const { author } = await seedArchive();
    const ctx = buildCtx();
    const result = await prepareAuthorData(ctx as any, author.uid, `https://example.com/author/${author.uid}/`, {}, new URL(`https://example.com/author/${author.uid}/`));
    if ('posts' in result) {
      const titles = result.posts.map((p: any) => p.title);
      expect(titles).toContain('Past Post');
      expect(titles).not.toContain('Future Post');
    } else {
      throw new Error('expected ThemeArchiveProps');
    }
  });
});
