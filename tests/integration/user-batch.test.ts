/**
 * Integration tests for POST /api/admin/user-batch
 *
 * Covers: delete action for users.
 * Verifies auth guards (admin only), self-deletion guard, content/comment
 * re-assignment to the acting admin, actual user deletion, and redirect behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { hashPassword } from '@/lib/auth';

// ---- shared DB ref -----------------------------------------------------------

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/user-batch';

// ---- helpers -----------------------------------------------------------------

const TEST_SECRET = 'user-batch-secret';
const TEST_AUTH_CODE = 'userbatchcode';

async function seedExtraUser(
  db: TestDatabase,
  name: string,
  group: string = 'contributor',
) {
  await db.insert(schema.users).values({
    name,
    password: await hashPassword('pass'),
    mail: `${name}@example.com`,
    group,
    authCode: `code-${name}`,
  });
  return (await db.query.users.findFirst({
    where: (t, { eq }) => eq(t.name, name),
  }))!;
}

function makeBatchRequest(
  uids: number[],
  cookieHeader: string,
  action = 'delete',
  referer = 'https://example.com/admin/manage-users',
): Request {
  const urlStr = `https://example.com/api/admin/user-batch?do=${action}`;
  const body = new URLSearchParams();
  for (const uid of uids) body.append('uid[]', String(uid));
  return new Request(urlStr, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader,
      referer,
    },
    body: body.toString(),
  });
}

// ---- tests -------------------------------------------------------------------

describe('POST /api/admin/user-batch', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  // -- Auth guards --

  it('returns 401 when no cookie', async () => {
    await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const req = makeBatchRequest([2], '');
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not administrator', async () => {
    const user = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE, group: 'editor' });
    const cookie = await makeAuthCookie(testDb, user.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = makeBatchRequest([2], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(403);
  });

  it('redirects to referer when no uids submitted', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = makeBatchRequest([], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  // -- delete action --

  it('deletes selected user', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);
    const target = await seedExtraUser(testDb, 'bob');

    const req = makeBatchRequest([target.uid], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const users = await testDb.select().from(schema.users);
    expect(users.map(u => u.uid)).not.toContain(target.uid);
  });

  it('cannot delete self', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);

    const req = makeBatchRequest([admin.uid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    // Admin should still exist
    const users = await testDb.select().from(schema.users);
    expect(users.map(u => u.uid)).toContain(admin.uid);
  });

  it('re-assigns deleted user contents to admin', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);
    const target = await seedExtraUser(testDb, 'carol');

    // Post owned by target user
    await testDb.insert(schema.contents).values({
      title: "Carol's Post",
      slug: 'carols-post',
      type: 'post',
      status: 'publish',
      authorId: target.uid,
    });

    const req = makeBatchRequest([target.uid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const post = await testDb.query.contents.findFirst();
    expect(post?.authorId).toBe(admin.uid);
  });

  it('re-assigns deleted user comments to admin', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);
    const target = await seedExtraUser(testDb, 'dave');

    await testDb.insert(schema.contents).values({
      title: 'Some Post',
      slug: 'some-post',
      type: 'post',
      status: 'publish',
      authorId: admin.uid,
    });
    const post = (await testDb.query.contents.findFirst())!;

    await testDb.insert(schema.comments).values({
      cid: post.cid!,
      author: 'Dave',
      text: 'Hello',
      status: 'approved',
      type: 'comment',
      created: 1,
      authorId: target.uid,
    });

    const req = makeBatchRequest([target.uid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const comment = await testDb.query.comments.findFirst();
    expect(comment?.authorId).toBe(admin.uid);
  });

  it('deletes multiple users in one request', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);
    const u1 = await seedExtraUser(testDb, 'user1');
    const u2 = await seedExtraUser(testDb, 'user2');
    const u3 = await seedExtraUser(testDb, 'user3');

    const req = makeBatchRequest([u1.uid, u2.uid, u3.uid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const remaining = await testDb.select().from(schema.users);
    // Only the admin should remain
    expect(remaining).toHaveLength(1);
    expect(remaining[0].uid).toBe(admin.uid);
  });

  it('skips non-existent uids gracefully', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);

    // uid 9999 does not exist
    const req = makeBatchRequest([9999], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  it('redirects to referer after delete', async () => {
    const admin = await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    const cookie = await makeAuthCookie(testDb, admin.uid, TEST_AUTH_CODE, TEST_SECRET);
    const target = await seedExtraUser(testDb, 'eve');

    const req = makeBatchRequest(
      [target.uid],
      cookie,
      'delete',
      'https://example.com/admin/manage-users?page=2',
    );
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('manage-users');
  });
});
