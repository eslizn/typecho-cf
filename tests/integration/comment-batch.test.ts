/**
 * Integration tests for /api/admin/comment-batch
 *
 * Covers: approve, waiting, spam, delete (batch POST), and delete-spam (GET/POST).
 * Verifies auth guards, commentsNum adjustments, and redirect behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb } from '../helpers';
import { hashPassword, generateAuthToken } from '@/lib/auth';

// ---- shared DB ref (mutated in beforeEach) -----------------------------------

let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return {
    ...actual,
    getDb: (_d1: any) => testDb,
    schema: actual.schema,
  };
});

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    requireAdminCSRF: async () => null,
  };
});

// Import both GET and POST exports (GET was the fix for delete-spam)
import { GET, POST } from '@/pages/api/admin/comment-batch';

const TEST_SECRET = 'test-secret-batch';
const TEST_AUTH_CODE = 'batchauthcode';

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
  const user = await db.query.users.findFirst();
  return user!;
}

async function makeAuthCookie(db: ReturnType<typeof createTestDb>, uid: number) {
  const token = await generateAuthToken(uid, TEST_AUTH_CODE, TEST_SECRET);
  const [uidPart, hash] = token.split(':');
  return `__typecho_uid=${uidPart}; __typecho_authCode=${hash}`;
}

async function seedPost(db: ReturnType<typeof createTestDb>, commentsNum = 0) {
  await db.insert(schema.contents).values({
    title: 'Test Post',
    slug: 'test-post',
    created: Math.floor(Date.now() / 1000),
    type: 'post',
    status: 'publish',
    allowComment: '1',
    commentsNum,
  });
  return (await db.query.contents.findFirst())!;
}

async function seedComment(
  db: ReturnType<typeof createTestDb>,
  postCid: number,
  status: 'approved' | 'waiting' | 'spam' = 'approved',
) {
  await db.insert(schema.comments).values({
    cid: postCid,
    author: 'Tester',
    text: 'Test comment',
    status,
    type: 'comment',
    created: Math.floor(Date.now() / 1000),
  });
  return (await db.query.comments.findFirst({
    where: (t, { eq }) => eq(t.status, status),
  }))!;
}

function makeBatchRequest(
  method: 'GET' | 'POST',
  action: string,
  coids: number[] = [],
  cookieHeader = '',
  referer = 'https://example.com/admin/manage-comments',
): Request {
  const urlStr = `https://example.com/api/admin/comment-batch?do=${action}`;
  if (method === 'GET') {
    return new Request(urlStr, {
      method: 'GET',
      headers: { cookie: cookieHeader, referer },
    });
  }
  const body = new URLSearchParams();
  for (const coid of coids) body.append('coid[]', String(coid));
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

describe('POST /api/admin/comment-batch', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  // -- Auth guards --

  it('returns 401 when no cookie', async () => {
    await seedAdmin(testDb);
    const req = makeBatchRequest('POST', 'delete', [1]);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not contributor', async () => {
    const admin = await seedAdmin(testDb, 'visitor');
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const req = makeBatchRequest('POST', 'delete', [1], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(403);
  });

  it('redirects to referer when no coids are submitted', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const req = makeBatchRequest('POST', 'delete', [], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  // -- delete action --

  it('deletes selected comments', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 2);
    const c1 = await seedComment(testDb, post.cid!, 'approved');
    const c2 = await seedComment(testDb, post.cid!, 'waiting');

    const req = makeBatchRequest('POST', 'delete', [c1.coid, c2.coid], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const remaining = await testDb.select().from(schema.comments);
    expect(remaining).toHaveLength(0);
  });

  it('decrements commentsNum when deleting approved comment', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 1);
    const comment = await seedComment(testDb, post.cid!, 'approved');

    const req = makeBatchRequest('POST', 'delete', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(0);
  });

  it('does NOT decrement commentsNum when deleting waiting comment', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 1);
    const comment = await seedComment(testDb, post.cid!, 'waiting');

    const req = makeBatchRequest('POST', 'delete', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(1); // untouched
  });

  // -- approved action --

  it('marks waiting comments as approved and increments commentsNum', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 0);
    const comment = await seedComment(testDb, post.cid!, 'waiting');

    const req = makeBatchRequest('POST', 'approved', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedComment = await testDb.query.comments.findFirst();
    expect(updatedComment?.status).toBe('approved');

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(1);
  });

  it('does NOT double-increment commentsNum if comment is already approved', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 1);
    const comment = await seedComment(testDb, post.cid!, 'approved');

    const req = makeBatchRequest('POST', 'approved', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(1); // unchanged
  });

  // -- waiting action --

  it('marks approved comment as waiting and decrements commentsNum', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 1);
    const comment = await seedComment(testDb, post.cid!, 'approved');

    const req = makeBatchRequest('POST', 'waiting', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedComment = await testDb.query.comments.findFirst();
    expect(updatedComment?.status).toBe('waiting');

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(0);
  });

  // -- spam action --

  it('marks approved comment as spam and decrements commentsNum', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 1);
    const comment = await seedComment(testDb, post.cid!, 'approved');

    const req = makeBatchRequest('POST', 'spam', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedComment = await testDb.query.comments.findFirst();
    expect(updatedComment?.status).toBe('spam');

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(0);
  });

  it('marks waiting comment as spam without changing commentsNum', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 0);
    const comment = await seedComment(testDb, post.cid!, 'waiting');

    const req = makeBatchRequest('POST', 'spam', [comment.coid], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedComment = await testDb.query.comments.findFirst();
    expect(updatedComment?.status).toBe('spam');

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(0); // unchanged
  });

  // -- multiple selection --

  it('processes multiple coids in a single request', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 0);

    // Seed 3 waiting comments
    await testDb.insert(schema.comments).values([
      { cid: post.cid!, author: 'A', text: 'c1', status: 'waiting', type: 'comment', created: 1 },
      { cid: post.cid!, author: 'B', text: 'c2', status: 'waiting', type: 'comment', created: 2 },
      { cid: post.cid!, author: 'C', text: 'c3', status: 'waiting', type: 'comment', created: 3 },
    ]);
    const allComments = await testDb.select().from(schema.comments);
    const coids = allComments.map(c => c.coid);

    const req = makeBatchRequest('POST', 'approved', coids, cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const updatedPost = await testDb.query.contents.findFirst();
    expect(updatedPost?.commentsNum).toBe(3);
  });
});

describe('GET /api/admin/comment-batch (delete-spam)', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it('GET export exists (fix: delete-spam triggered via location.href)', () => {
    expect(GET).toBeDefined();
    expect(typeof GET).toBe('function');
  });

  it('returns 401 when no cookie on GET', async () => {
    await seedAdmin(testDb);
    const req = makeBatchRequest('GET', 'delete-spam');
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('deletes all spam comments via GET delete-spam', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 0);

    // Seed spam and non-spam
    await testDb.insert(schema.comments).values([
      { cid: post.cid!, author: 'Spammer', text: 'spam1', status: 'spam', type: 'comment', created: 1 },
      { cid: post.cid!, author: 'Spammer', text: 'spam2', status: 'spam', type: 'comment', created: 2 },
      { cid: post.cid!, author: 'Good', text: 'legit', status: 'approved', type: 'comment', created: 3 },
    ]);

    const req = makeBatchRequest('GET', 'delete-spam', [], cookie);
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const remaining = await testDb.select().from(schema.comments);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('approved');
  });

  it('delete-spam via POST also works', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const post = await seedPost(testDb, 0);

    await testDb.insert(schema.comments).values([
      { cid: post.cid!, author: 'Spammer', text: 'spam', status: 'spam', type: 'comment', created: 1 },
    ]);

    const req = makeBatchRequest('POST', 'delete-spam', [], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const remaining = await testDb.select().from(schema.comments);
    expect(remaining).toHaveLength(0);
  });

  it('delete-spam redirects to manage-comments?status=spam', async () => {
    const admin = await seedAdmin(testDb);
    const cookie = await makeAuthCookie(testDb, admin.uid);
    await seedPost(testDb);

    const req = makeBatchRequest('GET', 'delete-spam', [], cookie);
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('manage-comments');
  });
});
