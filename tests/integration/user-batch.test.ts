/**
 * Integration tests for POST /api/admin/user-batch
 *
 * Covers: delete action for users.
 * Verifies auth guards (admin only), self-deletion guard, content/comment
 * re-assignment to the acting admin, actual user deletion, and redirect behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { hashPassword, generateAuthToken } from '@/lib/auth';

// ---- shared DB ref -----------------------------------------------------------

let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return {
    ...actual,
    getDb: (_d1: any) => testDb,
    schema: actual.schema,
  };
});

import { POST } from '@/pages/api/admin/user-batch';

// ---- helpers -----------------------------------------------------------------

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE typecho_options (
      name TEXT NOT NULL,
      "user" INTEGER NOT NULL DEFAULT 0,
      value TEXT,
      PRIMARY KEY (name, "user")
    );
    CREATE TABLE typecho_users (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      password TEXT,
      mail TEXT,
      url TEXT,
      screenName TEXT,
      created INTEGER DEFAULT 0,
      activated INTEGER DEFAULT 0,
      logged INTEGER DEFAULT 0,
      "group" TEXT DEFAULT 'visitor',
      authCode TEXT
    );
    CREATE TABLE typecho_contents (
      cid INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      slug TEXT UNIQUE,
      created INTEGER DEFAULT 0,
      modified INTEGER DEFAULT 0,
      text TEXT,
      "order" INTEGER DEFAULT 0,
      authorId INTEGER DEFAULT 0,
      template TEXT,
      type TEXT DEFAULT 'post',
      status TEXT DEFAULT 'publish',
      password TEXT,
      commentsNum INTEGER DEFAULT 0,
      allowComment TEXT DEFAULT '0',
      allowPing TEXT DEFAULT '0',
      allowFeed TEXT DEFAULT '0',
      parent INTEGER DEFAULT 0
    );
    CREATE TABLE typecho_comments (
      coid INTEGER PRIMARY KEY AUTOINCREMENT,
      cid INTEGER DEFAULT 0,
      created INTEGER DEFAULT 0,
      author TEXT,
      authorId INTEGER DEFAULT 0,
      ownerId INTEGER DEFAULT 0,
      mail TEXT,
      url TEXT,
      ip TEXT,
      agent TEXT,
      text TEXT,
      type TEXT DEFAULT 'comment',
      status TEXT DEFAULT 'approved',
      parent INTEGER DEFAULT 0
    );
  `);
  return drizzle(sqlite, { schema });
}

const TEST_SECRET = 'user-batch-secret';
const TEST_AUTH_CODE = 'userbatchcode';

async function seedAdmin(
  db: ReturnType<typeof createTestDb>,
  group: string = 'administrator',
) {
  await db.insert(schema.options).values({ name: 'secret', user: 0, value: TEST_SECRET });
  await db.insert(schema.users).values({
    name: 'admin',
    password: await hashPassword('admin123'),
    mail: 'admin@example.com',
    group,
    authCode: TEST_AUTH_CODE,
  });
  return (await db.query.users.findFirst())!;
}

async function seedExtraUser(
  db: ReturnType<typeof createTestDb>,
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

async function makeAuthCookie(db: ReturnType<typeof createTestDb>, uid: number) {
  const token = await generateAuthToken(uid, TEST_AUTH_CODE, TEST_SECRET);
  const [uidPart, hash] = token.split(':');
  return `__typecho_uid=${uidPart}; __typecho_authCode=${hash}`;
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
  beforeEach(() => {
    testDb = createTestDb();
  });

  // -- Auth guards --

  it('returns 401 when no cookie', async () => {
    await seedAdmin(testDb);
    const req = makeBatchRequest([2], '');
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not administrator', async () => {
    const user = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, user.uid);
    const req = makeBatchRequest([2], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(403);
  });

  it('redirects to referer when no uids submitted', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const req = makeBatchRequest([], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  // -- delete action --

  it('deletes selected user', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const target = await seedExtraUser(testDb, 'bob');

    const req = makeBatchRequest([target.uid], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const users = await testDb.select().from(schema.users);
    expect(users.map(u => u.uid)).not.toContain(target.uid);
  });

  it('cannot delete self', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);

    const req = makeBatchRequest([admin.uid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    // Admin should still exist
    const users = await testDb.select().from(schema.users);
    expect(users.map(u => u.uid)).toContain(admin.uid);
  });

  it('re-assigns deleted user contents to admin', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
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
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
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
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
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
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);

    // uid 9999 does not exist
    const req = makeBatchRequest([9999], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  it('redirects to referer after delete', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
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
