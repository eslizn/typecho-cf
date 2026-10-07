/**
 * Integration tests for POST /api/admin/content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { eq, and, sql } from 'drizzle-orm';

let testDb: TestDatabase;
const { mockApplyFilter, mockDoHook } = vi.hoisted(() => ({
  mockApplyFilter: vi.fn(async (_ctx: any, _hook: string, data: any) => data),
  mockDoHook: vi.fn(async () => {}),
}));

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: mockApplyFilter,
  doHook: mockDoHook,
}));

import { POST } from '@/pages/api/admin/content';

const TEST_SECRET = 'content-secret';
const TEST_AUTH_CODE = 'content-auth-code';

async function makeContentRequest(fields: Record<string, string>, cookie: string) {
  const body = new URLSearchParams(fields);
  return new Request('https://example.com/api/admin/content', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      // G2-1: requireAdminAction enforces same-origin via Origin/Referer.
      origin: 'https://example.com',
    },
    body: body.toString(),
  });
}

describe('POST /api/admin/content', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
    mockApplyFilter.mockImplementation(async (_ctx: any, _hook: string, data: any) => data);
    mockDoHook.mockClear();
  });

  it('counts duplicate tag names once when creating content', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Tagged post',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
      tags: 'astro, astro, Astro',
      allowFeed: '1',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const tags = await testDb.select().from(schema.metas).where(eq(schema.metas.type, 'tag'));
    const rels = await testDb.select().from(schema.relationships);
    expect(tags).toHaveLength(1);
    expect(tags[0].count).toBe(1);
    expect(rels).toHaveLength(1);
  });

  it('rolls back content, fields, category and tag writes when the atomic create batch fails', async () => {
    const [category] = await testDb.insert(schema.metas).values({
      name: 'News', slug: 'news-atomic', type: 'category', count: 0,
    }).returning();
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Must roll back',
      slug: 'must-roll-back',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
      'category[]': String(category.mid),
      tags: 'atomic-tag',
      'fieldNames[]': 'source',
      'fieldTypes[source]': 'str',
      'fieldValues[source]': 'test',
    }, cookie);

    const originalBatch = testDb.batch.bind(testDb);
    const batchSpy = vi.spyOn(testDb, 'batch').mockImplementation(((statements: any[]) =>
      originalBatch([
        ...statements,
        // Fail after every content/meta/field/relationship/count statement
        // has run inside the same SQLite transaction.
        testDb.insert(schema.users).values({ name: 'admin', mail: 'admin@example.com' }),
      ] as any)) as any);
    mockDoHook.mockClear();

    await expect(POST({ request, locals: {} } as any)).rejects.toThrow(/unique constraint/i);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(await testDb.query.contents.findFirst({ where: eq(schema.contents.title, 'Must roll back') })).toBeUndefined();
    expect(await testDb.query.metas.findFirst({ where: eq(schema.metas.slug, 'atomic-tag') })).toBeUndefined();
    expect(await testDb.select().from(schema.relationships)).toHaveLength(0);
    expect(await testDb.select().from(schema.fields)).toHaveLength(0);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))?.count).toBe(0);
    expect(mockDoHook).not.toHaveBeenCalled();

    batchSpy.mockRestore();
  });

  it('deduplicates slug when updating to another content slug', async () => {
    await testDb.insert(schema.contents).values({
      title: 'First',
      slug: 'shared-slug',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    await testDb.insert(schema.contents).values({
      title: 'Second',
      slug: 'second',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    const second = await testDb.query.contents.findFirst({
      where: eq(schema.contents.slug, 'second'),
    });

    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update',
      cid: String(second!.cid),
      type: 'post',
      title: 'Second updated',
      slug: 'shared-slug',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const updated = await testDb.query.contents.findFirst({
      where: eq(schema.contents.cid, second!.cid),
    });
    expect(updated?.slug).toBe(`shared-slug-${second!.cid}`);
  });

  it('deduplicates a new content slug before it can hit the database constraint', async () => {
    await testDb.insert(schema.contents).values({
      title: 'Existing', slug: 'new-shared-slug', type: 'post', status: 'publish', authorId: 1,
    });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({
      do: 'create', type: 'post', title: 'New post', slug: 'new-shared-slug', text: 'Body',
      status: 'publish', visibility: 'publish',
    }, cookie);
    expect((await POST({ request, locals: {} } as any)).status).toBe(302);
    const created = await testDb.query.contents.findFirst({ where: eq(schema.contents.title, 'New post') });
    expect(created?.slug).toBe(`new-shared-slug-${created?.cid}`);
  });

  it('saves an edit of a published post as a revision and keeps the published row', async () => {
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Published', slug: 'published', text: 'Live body', type: 'post', status: 'publish', authorId: 1,
      created: 1000,
    }).returning({ cid: schema.contents.cid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update', cid: String(post.cid), type: 'post', title: 'Edited', slug: 'published', text: 'Draft body',
      status: 'draft', visibility: 'publish',
    }, cookie);
    expect((await POST({ request: req, locals: {} } as any)).status).toBe(302);
    const saved = await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, post.cid) });
    const revision = await testDb.query.contents.findFirst({
      where: eq(schema.contents.type, 'revision'),
    });
    expect(saved).toMatchObject({ title: 'Published', text: 'Live body', type: 'post', status: 'publish', created: 1000 });
    expect(revision).toMatchObject({ title: 'Edited', text: 'Draft body', type: 'revision', status: 'draft', parent: post.cid });
  });

  it('restores protected author and type fields after a malicious write filter', async () => {
    mockApplyFilter.mockImplementationOnce(async (_ctx: any, _hook: string, data: any) => ({
      ...data,
      title: 'Filtered title',
      authorId: 999,
      type: 'attachment',
      cid: 999,
    }));
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create', type: 'post', title: 'Original', text: 'Body',
      status: 'publish', visibility: 'publish', allowFeed: '1',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const saved = await testDb.query.contents.findFirst();
    expect(saved).toMatchObject({ title: 'Filtered title', authorId: admin!.uid, type: 'post' });
    expect(saved?.cid).not.toBe(999);
  });

  it('updates one revision on repeated draft saves and removes it on publish', async () => {
    const [post] = await testDb.insert(schema.contents).values({ title: 'Live', slug: 'live', text: 'old', type: 'post', status: 'publish', authorId: 1, created: 1000 }).returning({ cid: schema.contents.cid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const save = (text: string) => makeContentRequest({ do: 'update', cid: String(post.cid), type: 'post', title: 'Live', slug: 'live', text, status: 'draft', visibility: 'publish' }, cookie);
    await POST({ request: await save('draft 1'), locals: {} } as any);
    await POST({ request: await save('draft 2'), locals: {} } as any);
    let revisions = await testDb.select().from(schema.contents).where(eq(schema.contents.type, 'revision'));
    expect(revisions).toHaveLength(1);
    expect(revisions[0].text).toBe('draft 2');
    const publish = await makeContentRequest({ do: 'update', cid: String(post.cid), type: 'post', title: 'Published again', slug: 'live', text: 'new live', status: 'publish', visibility: 'publish' }, cookie);
    await POST({ request: publish, locals: {} } as any);
    revisions = await testDb.select().from(schema.contents).where(eq(schema.contents.type, 'revision'));
    const updated = await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, post.cid) });
    expect(revisions).toHaveLength(0);
    expect(updated).toMatchObject({ title: 'Published again', text: 'new live', type: 'post', status: 'publish' });
  });

  it('keeps revision metadata isolated from published counts', async () => {
    const [category] = await testDb.insert(schema.metas).values({ name: 'News', slug: 'news', type: 'category', count: 1 }).returning();
    const [post] = await testDb.insert(schema.contents).values({ title: 'Live', slug: 'live-meta', text: 'old', type: 'post', status: 'publish', authorId: 1 }).returning({ cid: schema.contents.cid });
    await testDb.insert(schema.relationships).values({ cid: post.cid, mid: category.mid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    await POST({ request: await makeContentRequest({ do: 'update', cid: String(post.cid), type: 'post', title: 'Draft', slug: 'live-meta', text: 'draft', status: 'draft', visibility: 'publish', 'category[]': String(category.mid), 'fieldNames[]': 'source', 'fieldTypes[source]': 'str', 'fieldValues[source]': 'draft' }, cookie), locals: {} } as any);
    const revision = await testDb.query.contents.findFirst({ where: eq(schema.contents.type, 'revision') });
    expect(revision).toBeTruthy();
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))?.count).toBe(1);
    expect((await testDb.query.fields.findFirst({ where: eq(schema.fields.cid, revision!.cid) }))?.str_value).toBe('draft');
  });

  it('recomputes live metadata counts for concurrent updates with the same old relationship snapshot', async () => {
    const [oldCategory, categoryA, categoryB] = await testDb.insert(schema.metas).values([
      { name: 'Old', slug: 'old-count-cat', type: 'category', count: 1 },
      { name: 'A', slug: 'count-cat-a', type: 'category', count: 0 },
      { name: 'B', slug: 'count-cat-b', type: 'category', count: 0 },
    ]).returning();
    const [oldTag, tagA, tagB] = await testDb.insert(schema.metas).values([
      { name: 'Old tag', slug: 'old-count-tag', type: 'tag', count: 1 },
      { name: 'Tag A', slug: 'count-tag-a', type: 'tag', count: 0 },
      { name: 'Tag B', slug: 'count-tag-b', type: 'tag', count: 0 },
    ]).returning();
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Concurrent', slug: 'concurrent-counts', type: 'post', status: 'publish', authorId: 1,
    }).returning();
    await testDb.insert(schema.relationships).values([
      { cid: post.cid, mid: oldCategory.mid },
      { cid: post.cid, mid: oldTag.mid },
    ]);
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const update = (categoryMid: number, tag: string) => makeContentRequest({
      do: 'update', cid: String(post.cid), type: 'post', title: 'Concurrent',
      slug: 'concurrent-counts', text: 'Body', status: 'publish', visibility: 'publish',
      'category[]': String(categoryMid), tags: tag,
    }, cookie);

    let waiting = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
    const originalBatch = testDb.batch.bind(testDb);
    const batchSpy = vi.spyOn(testDb, 'batch').mockImplementation((async (statements: any[]) => {
      waiting += 1;
      if (waiting === 2) openBarrier();
      if (waiting <= 2) await barrier;
      return originalBatch(statements as any);
    }) as any);

    const [responseA, responseB] = await Promise.all([
      update(categoryA.mid, 'count-tag-a').then((request) => POST({ request, locals: {} } as any)),
      update(categoryB.mid, 'count-tag-b').then((request) => POST({ request, locals: {} } as any)),
    ]);

    expect(responseA.status).toBe(302);
    expect(responseB.status).toBe(302);
    expect(batchSpy).toHaveBeenCalledTimes(2);
    const finalRelationships = await testDb.select().from(schema.relationships).where(eq(schema.relationships.cid, post.cid));
    expect(finalRelationships).toHaveLength(2);
    const metas = [oldCategory, categoryA, categoryB, oldTag, tagA, tagB];
    for (const meta of metas) {
      const [{ count }] = await testDb.select({ count: sql<number>`count(*)` })
        .from(schema.relationships)
        .innerJoin(schema.contents, eq(schema.relationships.cid, schema.contents.cid))
        .where(and(eq(schema.relationships.mid, meta.mid), sql`${schema.contents.type} <> 'revision'`));
      const current = await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, meta.mid) });
      expect(current?.count).toBe(count);
    }
    batchSpy.mockRestore();
  });

  it('rolls back content, fields, tag rows, relationships and counts when an update batch fails late', async () => {
    const [oldCategory, newCategory] = await testDb.insert(schema.metas).values([
      { name: 'Old', slug: 'rollback-old-category', type: 'category', count: 1 },
      { name: 'New', slug: 'rollback-new-category', type: 'category', count: 0 },
    ]).returning();
    const [oldTag] = await testDb.insert(schema.metas).values({
      name: 'Old tag', slug: 'rollback-old-tag', type: 'tag', count: 1,
    }).returning();
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Before', slug: 'rollback-content', text: 'Before body', type: 'post', status: 'publish', authorId: 1,
    }).returning();
    const [activeRevision] = await testDb.insert(schema.contents).values({
      title: 'Pending', slug: post.slug, text: 'Pending body', type: 'revision', status: 'draft', parent: post.cid, authorId: 1,
    }).returning();
    await testDb.insert(schema.relationships).values([
      { cid: post.cid, mid: oldCategory.mid },
      { cid: post.cid, mid: oldTag.mid },
      { cid: activeRevision.cid, mid: newCategory.mid },
    ]);
    await testDb.insert(schema.fields).values({ cid: post.cid, name: 'source', str_value: 'old' });
    await testDb.insert(schema.fields).values({ cid: activeRevision.cid, name: 'source', str_value: 'pending' });
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({
      do: 'update', cid: String(post.cid), type: 'post', title: 'After',
      slug: 'rollback-content', text: 'After body', status: 'publish', visibility: 'publish',
      'category[]': String(newCategory.mid), tags: 'rollback-new-tag',
      'fieldNames[]': 'source', 'fieldTypes[source]': 'str', 'fieldValues[source]': 'new',
    }, cookie);

    const originalBatch = testDb.batch.bind(testDb);
    const batchSpy = vi.spyOn(testDb, 'batch').mockImplementation(((statements: any[]) =>
      originalBatch([
        ...statements,
        testDb.insert(schema.users).values({ name: 'admin', mail: 'admin@example.com' }),
      ] as any)) as any);
    mockDoHook.mockClear();

    await expect(POST({ request, locals: {} } as any)).rejects.toThrow(/unique constraint/i);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, post.cid) }))
      .toMatchObject({ title: 'Before', text: 'Before body', slug: 'rollback-content' });
    expect((await testDb.query.fields.findFirst({ where: eq(schema.fields.cid, post.cid) }))?.str_value).toBe('old');
    expect(await testDb.query.metas.findFirst({ where: eq(schema.metas.slug, 'rollback-new-tag') })).toBeUndefined();
    expect(await testDb.select().from(schema.relationships).where(eq(schema.relationships.cid, post.cid)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ mid: oldCategory.mid }),
        expect.objectContaining({ mid: oldTag.mid }),
      ]));
    expect(await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, activeRevision.cid) })).toBeTruthy();
    expect(await testDb.query.fields.findFirst({ where: eq(schema.fields.cid, activeRevision.cid) }))
      .toMatchObject({ str_value: 'pending' });
    expect(await testDb.select().from(schema.relationships).where(eq(schema.relationships.cid, activeRevision.cid)))
      .toMatchObject([expect.objectContaining({ mid: newCategory.mid })]);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, oldCategory.mid) }))?.count).toBe(1);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, newCategory.mid) }))?.count).toBe(0);
    expect(mockDoHook).not.toHaveBeenCalled();
    batchSpy.mockRestore();
  });

  it('rolls back a new revision with its fields and relationships when its batch fails late', async () => {
    const [category] = await testDb.insert(schema.metas).values({
      name: 'Published category', slug: 'revision-atomic-category', type: 'category', count: 1,
    }).returning();
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Published', slug: 'revision-atomic-post', text: 'Live body', type: 'post', status: 'publish', authorId: 1,
    }).returning();
    await testDb.insert(schema.relationships).values({ cid: post.cid, mid: category.mid });
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({
      do: 'update', cid: String(post.cid), type: 'post', title: 'Draft',
      slug: 'revision-atomic-post', text: 'Draft body', status: 'draft', visibility: 'publish',
      'category[]': String(category.mid), tags: 'revision-atomic-tag',
      'fieldNames[]': 'source', 'fieldTypes[source]': 'str', 'fieldValues[source]': 'draft',
    }, cookie);

    const originalBatch = testDb.batch.bind(testDb);
    const batchSpy = vi.spyOn(testDb, 'batch').mockImplementation(((statements: any[]) =>
      originalBatch([
        ...statements,
        testDb.insert(schema.users).values({ name: 'admin', mail: 'admin@example.com' }),
      ] as any)) as any);
    mockDoHook.mockClear();

    await expect(POST({ request, locals: {} } as any)).rejects.toThrow(/unique constraint/i);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(await testDb.select().from(schema.contents).where(eq(schema.contents.type, 'revision'))).toHaveLength(0);
    expect(await testDb.query.metas.findFirst({ where: eq(schema.metas.slug, 'revision-atomic-tag') })).toBeUndefined();
    expect(await testDb.select().from(schema.fields)).toHaveLength(0);
    expect(await testDb.select().from(schema.relationships)).toEqual([
      expect.objectContaining({ cid: post.cid, mid: category.mid }),
    ]);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))?.count).toBe(1);
    expect(mockDoHook).not.toHaveBeenCalled();
    batchSpy.mockRestore();
  });

  it.each(['post', 'page'])('fires save and publish hooks after updating a %s draft', async (type) => {
    const [draft] = await testDb.insert(schema.contents).values({ title: 'Draft', slug: `draft-${type}`, type: `${type}_draft`, status: 'draft', authorId: 1 }).returning();
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({ do: 'update', cid: String(draft.cid), type, title: 'Published', text: 'Body', status: 'publish', visibility: 'publish' }, cookie);
    expect((await POST({ request, locals: {} } as any)).status).toBe(302);
    expect(mockDoHook.mock.calls.map((call: any[]) => call[1])).toEqual([`${type}:afterPublish`, `${type}:afterSave`]);
    const saved = await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, draft.cid) });
    expect(mockDoHook).toHaveBeenCalledWith(expect.anything(), `${type}:afterSave`, expect.objectContaining({ cid: draft.cid, title: saved!.title, type }), expect.anything());
  });

  it('deletes revision children and their metadata without decrementing their uncounted links', async () => {
    const [category] = await testDb.insert(schema.metas).values({ name: 'Shared', slug: 'shared-delete', type: 'category', count: 2 }).returning();
    const [post] = await testDb.insert(schema.contents).values({ title: 'Parent', slug: 'parent-delete', type: 'post', status: 'publish', authorId: 1 }).returning();
    const [revision] = await testDb.insert(schema.contents).values({ title: 'Draft', slug: post.slug, type: 'revision', status: 'draft', parent: post.cid, authorId: 1 }).returning();
    await testDb.insert(schema.relationships).values([{ cid: post.cid, mid: category.mid }, { cid: revision.cid, mid: category.mid }]);
    await testDb.insert(schema.fields).values({ cid: revision.cid, name: 'source', str_value: 'revision' });
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({ do: 'delete', cid: String(post.cid) }, cookie);
    expect((await POST({ request, locals: {} } as any)).status).toBe(302);
    expect(await testDb.select().from(schema.contents)).toHaveLength(0);
    expect(await testDb.select().from(schema.relationships)).toHaveLength(0);
    expect(await testDb.select().from(schema.fields)).toHaveLength(0);
    expect((await testDb.query.metas.findFirst())!.count).toBe(0);
  });

  it('keeps live counts correct when concurrent deletes share a stale relationship snapshot', async () => {
    const [category] = await testDb.insert(schema.metas).values({
      name: 'Shared', slug: 'concurrent-delete-category', type: 'category', count: 1,
    }).returning();
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Parent', slug: 'concurrent-delete-post', type: 'post', status: 'publish', authorId: 1,
    }).returning();
    const [revision] = await testDb.insert(schema.contents).values({
      title: 'Draft', slug: post.slug, type: 'revision', status: 'draft', parent: post.cid, authorId: 1,
    }).returning();
    await testDb.insert(schema.relationships).values([
      { cid: post.cid, mid: category.mid },
      { cid: revision.cid, mid: category.mid },
    ]);
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const deleteRequest = () => makeContentRequest({ do: 'delete', cid: String(post.cid) }, cookie);

    let waiting = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
    const originalBatch = testDb.batch.bind(testDb);
    const batchSpy = vi.spyOn(testDb, 'batch').mockImplementation((async (statements: any[]) => {
      waiting += 1;
      if (waiting === 2) openBarrier();
      if (waiting <= 2) await barrier;
      return originalBatch(statements as any);
    }) as any);

    const [responseA, responseB] = await Promise.all([
      deleteRequest().then((request) => POST({ request, locals: {} } as any)),
      deleteRequest().then((request) => POST({ request, locals: {} } as any)),
    ]);

    expect(responseA.status).toBe(302);
    expect(responseB.status).toBe(302);
    expect(batchSpy).toHaveBeenCalledTimes(2);
    expect(await testDb.select().from(schema.contents)).toHaveLength(0);
    expect(await testDb.select().from(schema.relationships)).toHaveLength(0);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))?.count).toBe(0);
    batchSpy.mockRestore();
  });

  it('rolls back parent and revision deletes when the late delete batch fails', async () => {
    const [category] = await testDb.insert(schema.metas).values({
      name: 'Shared', slug: 'delete-rollback-category', type: 'category', count: 1,
    }).returning();
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Parent', slug: 'delete-rollback-post', type: 'post', status: 'publish', authorId: 1,
    }).returning();
    const [revision] = await testDb.insert(schema.contents).values({
      title: 'Draft', slug: post.slug, type: 'revision', status: 'draft', parent: post.cid, authorId: 1,
    }).returning();
    await testDb.insert(schema.relationships).values([
      { cid: post.cid, mid: category.mid },
      { cid: revision.cid, mid: category.mid },
    ]);
    await testDb.insert(schema.fields).values({ cid: revision.cid, name: 'source', str_value: 'draft' });
    const cookie = await makeAuthCookie(testDb, 1, TEST_AUTH_CODE, TEST_SECRET);
    const request = await makeContentRequest({ do: 'delete', cid: String(post.cid) }, cookie);
    const originalBatch = testDb.batch.bind(testDb);
    const batchSpy = vi.spyOn(testDb, 'batch').mockImplementation(((statements: any[]) =>
      originalBatch([
        ...statements,
        testDb.insert(schema.users).values({ name: 'admin', mail: 'admin@example.com' }),
      ] as any)) as any);
    mockDoHook.mockClear();

    await expect(POST({ request, locals: {} } as any)).rejects.toThrow(/unique constraint/i);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(await testDb.select().from(schema.contents)).toHaveLength(2);
    expect(await testDb.select().from(schema.relationships)).toHaveLength(2);
    expect(await testDb.select().from(schema.fields)).toHaveLength(1);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))?.count).toBe(1);
    expect(mockDoHook.mock.calls.map((call: any[]) => call[1])).toEqual(['post:beforeDelete']);
    batchSpy.mockRestore();
  });
});
