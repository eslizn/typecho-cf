/**
 * G7-1 regression: meta delete refuses to drop the default category
 * or any category that still has posts attached.
 *
 * The legacy code happily deleted the default category (leaving the
 * `defaultCategory` option dangling) and orphaned every assigned
 * post when an in-use category was dropped. We now short-circuit
 * with HTTP 400 before any rows are touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/meta';

const TEST_SECRET = 'meta-secret';
const TEST_AUTH_CODE = 'meta-auth';

async function seedSiteUrl(value = 'https://example.com') {
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value });
}

async function seedDefaultCategory(mid?: number) {
  // When mid is supplied, point defaultCategory at it explicitly. Otherwise
  // assume mid=1 (Drizzle autoincrement).
  await testDb.insert(schema.options).values({
    name: 'defaultCategory',
    user: 0,
    value: String(mid ?? 1),
  });
}

function buildDeleteRequest(mid: number, cookie: string) {
  const body = new URLSearchParams();
  body.set('action', 'delete');
  body.set('type', 'category');
  body.append('mid[]', String(mid));
  return new Request('https://example.com/api/admin/meta', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: 'https://example.com',
    },
    body: body.toString(),
  });
}

describe('POST /api/admin/meta delete (G7-1)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedSiteUrl();
  });

  it('refuses to delete the configured default category', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);

    const inserted = await testDb.insert(schema.metas).values({
      name: '默认分类', slug: 'default', type: 'category', count: 0, order: 1,
    }).returning({ mid: schema.metas.mid });
    const defaultMid = inserted[0].mid;
    await seedDefaultCategory(defaultMid);

    const res = await POST({
      request: buildDeleteRequest(defaultMid, cookie),
      locals: {},
      url: new URL('https://example.com/api/admin/meta'),
    } as any);

    expect(res.status).toBe(400);
    const remaining = await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, defaultMid) });
    expect(remaining).toBeTruthy();
  });

  it('refuses to delete a category that still has posts attached', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);

    const defaultIns = await testDb.insert(schema.metas).values({
      name: '默认', slug: 'default', type: 'category', count: 0, order: 1,
    }).returning({ mid: schema.metas.mid });
    const defaultMid = defaultIns[0].mid;
    await seedDefaultCategory(defaultMid);

    const otherIns = await testDb.insert(schema.metas).values({
      name: 'Tech', slug: 'tech', type: 'category', count: 1, order: 2,
    }).returning({ mid: schema.metas.mid });
    const inUseMid = otherIns[0].mid;

    await testDb.insert(schema.contents).values({
      title: 'Hello', slug: 'hello', type: 'post', status: 'publish', authorId: admin.uid, created: 100,
    });
    const post = (await testDb.query.contents.findFirst())!;
    await testDb.insert(schema.relationships).values({ cid: post.cid, mid: inUseMid });

    const res = await POST({
      request: buildDeleteRequest(inUseMid, cookie),
      locals: {},
      url: new URL('https://example.com/api/admin/meta'),
    } as any);

    expect(res.status).toBe(400);
    const stillThere = await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, inUseMid) });
    expect(stillThere).toBeTruthy();
    const rels = await testDb.select().from(schema.relationships);
    expect(rels).toHaveLength(1);
  });

  it('allows deleting an empty non-default category', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);

    const defaultIns = await testDb.insert(schema.metas).values({
      name: '默认', slug: 'default', type: 'category', count: 0, order: 1,
    }).returning({ mid: schema.metas.mid });
    await seedDefaultCategory(defaultIns[0].mid);

    const orphanIns = await testDb.insert(schema.metas).values({
      name: 'Empty', slug: 'empty', type: 'category', count: 0, order: 2,
    }).returning({ mid: schema.metas.mid });
    const orphanMid = orphanIns[0].mid;

    const res = await POST({
      request: buildDeleteRequest(orphanMid, cookie),
      locals: {},
      url: new URL('https://example.com/api/admin/meta'),
    } as any);

    expect(res.status).toBe(302);
    const gone = await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, orphanMid) });
    expect(gone).toBeFalsy();
  });
});
