/**
 * Integration tests for POST /api/admin/content-batch
 *
 * Covers: delete and mark actions for posts and pages.
 * Verifies auth guards, permission checks, meta count adjustments, and redirects.
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

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: async (_hook: string, data: any) => data,
  doHook: async () => {},
}));

import { POST } from '@/pages/api/admin/content-batch';

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
    CREATE TABLE typecho_metas (
      mid INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      slug TEXT,
      type TEXT DEFAULT 'category',
      description TEXT,
      count INTEGER DEFAULT 0,
      "order" INTEGER DEFAULT 0,
      parent INTEGER DEFAULT 0
    );
    CREATE TABLE typecho_relationships (
      cid INTEGER NOT NULL,
      mid INTEGER NOT NULL,
      PRIMARY KEY (cid, mid)
    );
    CREATE TABLE typecho_fields (
      cid INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'str',
      str_value TEXT,
      int_value INTEGER DEFAULT 0,
      float_value REAL DEFAULT 0,
      PRIMARY KEY (cid, name)
    );
  `);
  return drizzle(sqlite, { schema });
}

const TEST_SECRET = 'content-batch-secret';
const TEST_AUTH_CODE = 'contentbatchcode';

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

async function makeAuthCookie(db: ReturnType<typeof createTestDb>, uid: number) {
  const token = await generateAuthToken(uid, TEST_AUTH_CODE, TEST_SECRET);
  const [uidPart, hash] = token.split(':');
  return `__typecho_uid=${uidPart}; __typecho_authCode=${hash}`;
}

async function seedPost(
  db: ReturnType<typeof createTestDb>,
  overrides: Partial<typeof schema.contents.$inferInsert> = {},
  authorId = 1,
) {
  const slug = overrides.slug || `post-${Date.now()}-${Math.random()}`;
  await db.insert(schema.contents).values({
    title: 'Test Post',
    slug,
    created: Math.floor(Date.now() / 1000),
    type: 'post',
    status: 'publish',
    allowComment: '1',
    authorId,
    ...overrides,
  });
  return (await db.query.contents.findFirst({
    where: (t, { eq }) => eq(t.slug, slug),
  }))!;
}

function makeBatchRequest(
  action: string,
  cids: number[],
  cookieHeader: string,
  extraParams: Record<string, string> = {},
  referer = 'https://example.com/admin/manage-posts',
): Request {
  const params = new URLSearchParams({ do: action, ...extraParams });
  const urlStr = `https://example.com/api/admin/content-batch?${params}`;
  const body = new URLSearchParams();
  for (const cid of cids) body.append('cid[]', String(cid));
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

describe('POST /api/admin/content-batch', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  // -- Auth guards --

  it('returns 401 when no cookie', async () => {
    await seedAdmin(testDb);
    const req = makeBatchRequest('delete', [1], '');
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not contributor', async () => {
    const user = await seedAdmin(testDb, 'visitor');
    const cookie = await makeAuthCookie(testDb, user.uid);
    const req = makeBatchRequest('delete', [1], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(403);
  });

  it('redirects to referer when no cids are submitted', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const req = makeBatchRequest('delete', [], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  // -- delete action --

  it('deletes selected posts', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const p1 = await seedPost(testDb, { slug: 'p1' });
    const p2 = await seedPost(testDb, { slug: 'p2' });

    const req = makeBatchRequest('delete', [p1.cid!, p2.cid!], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(0);
  });

  it('also deletes associated comments and fields when deleting post', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, { slug: 'post-with-comments' });

    // Add a comment and a field
    await testDb.insert(schema.comments).values({
      cid: post.cid!,
      author: 'Alice',
      text: 'Hello',
      status: 'approved',
      type: 'comment',
      created: 1,
    });
    await testDb.insert(schema.fields).values({
      cid: post.cid!,
      name: 'custom_field',
      type: 'str',
      str_value: 'value',
    });

    const req = makeBatchRequest('delete', [post.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const comments = await testDb.select().from(schema.comments);
    expect(comments).toHaveLength(0);

    const fields = await testDb.select().from(schema.fields);
    expect(fields).toHaveLength(0);
  });

  it('decrements meta count when post with category relationship is deleted', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, { slug: 'categorized-post' });

    // Add a category with count=2
    await testDb.insert(schema.metas).values({
      name: 'Tech',
      slug: 'tech',
      type: 'category',
      count: 2,
    });
    const cat = (await testDb.query.metas.findFirst())!;
    await testDb.insert(schema.relationships).values({ cid: post.cid!, mid: cat.mid });

    const req = makeBatchRequest('delete', [post.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedCat = await testDb.query.metas.findFirst();
    expect(updatedCat?.count).toBe(1);
  });

  it('contributor can only delete their own posts', async () => {
    // Admin (uid=1) is the owner; contributor (uid=2) tries to delete admin's post
    const admin = await seedAdmin(testDb, 'contributor');
    const cookie = await makeAuthCookie(testDb, admin.uid);

    // Seed a post owned by a different (non-existent) user id=99
    const post = await seedPost(testDb, { slug: 'other-post', authorId: 99 });

    const req = makeBatchRequest('delete', [post.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    // Post should NOT be deleted since contributor doesn't own it
    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(1);
  });

  // -- mark action --

  it('returns 403 when contributor tries to mark status', async () => {
    const admin = await seedAdmin(testDb, 'contributor');
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, { slug: 'contrib-post' });

    const req = makeBatchRequest('mark', [post.cid!], cookie, { status: 'hidden' });
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(403);
  });

  it('editor can mark post status to publish', async () => {
    const editor = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);
    const post = await seedPost(testDb, { slug: 'draft-post', status: 'waiting' });

    const req = makeBatchRequest('mark', [post.cid!], cookie, { status: 'publish' });
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const updated = await testDb.query.contents.findFirst();
    expect(updated?.status).toBe('publish');
  });

  it('editor can mark post status to hidden', async () => {
    const editor = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);
    const post = await seedPost(testDb, { slug: 'visible-post', status: 'publish' });

    const req = makeBatchRequest('mark', [post.cid!], cookie, { status: 'hidden' });
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updated = await testDb.query.contents.findFirst();
    expect(updated?.status).toBe('hidden');
  });

  it('editor can mark post status to waiting', async () => {
    const editor = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);
    const post = await seedPost(testDb, { slug: 'pub-post', status: 'publish' });

    const req = makeBatchRequest('mark', [post.cid!], cookie, { status: 'waiting' });
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updated = await testDb.query.contents.findFirst();
    expect(updated?.status).toBe('waiting');
  });

  it('editor can mark post status to private', async () => {
    const editor = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);
    const post = await seedPost(testDb, { slug: 'pub-post-2', status: 'publish' });

    const req = makeBatchRequest('mark', [post.cid!], cookie, { status: 'private' });
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updated = await testDb.query.contents.findFirst();
    expect(updated?.status).toBe('private');
  });

  it('rejects invalid status value', async () => {
    const editor = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);
    const post = await seedPost(testDb, { slug: 'status-test', status: 'publish' });

    const req = makeBatchRequest('mark', [post.cid!], cookie, { status: 'evil' });
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    // Status must remain unchanged when invalid status is given
    const updated = await testDb.query.contents.findFirst();
    expect(updated?.status).toBe('publish');
  });

  it('marks multiple posts in one request', async () => {
    const editor = await seedAdmin(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);
    const p1 = await seedPost(testDb, { slug: 'multi-1', status: 'publish' });
    const p2 = await seedPost(testDb, { slug: 'multi-2', status: 'publish' });

    const req = makeBatchRequest('mark', [p1.cid!, p2.cid!], cookie, { status: 'hidden' });
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const all = await testDb.select().from(schema.contents);
    expect(all.every(p => p.status === 'hidden')).toBe(true);
  });

  // -- page batch (type=page) --

  it('deletes pages when type=page is specified', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const page = await seedPost(testDb, { slug: 'my-page', type: 'page' });

    const req = makeBatchRequest('delete', [page.cid!], cookie, { type: 'page' });
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(0);
  });

  it('redirects to manage-pages when type=page after operation', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);

    // No cids → redirect immediately
    const req = makeBatchRequest('delete', [], cookie, { type: 'page' }, 'https://example.com/admin/manage-pages');
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('manage-pages');
  });
});
