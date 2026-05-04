/**
 * Integration tests for POST /api/admin/media-batch
 *
 * Covers: delete action for attachments.
 * Verifies auth guards, permission checks (editor/admin only), type guard
 * (non-attachment cids are ignored), ownership restriction for non-admins,
 * R2 deletion attempt, and redirect behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb } from '../helpers';
import { hashPassword, generateAuthToken } from '@/lib/auth';

// ---- shared DB ref -----------------------------------------------------------

let testDb: ReturnType<typeof createTestDb>;

// R2 BUCKET mock — must be hoisted so the vi.mock factory can reference it
const { mockBucketDelete } = vi.hoisted(() => ({
  mockBucketDelete: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: null,
    BUCKET: { delete: mockBucketDelete },
  },
  caches: { default: { match: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import { POST } from '@/pages/api/admin/media-batch';

// ---- helpers -----------------------------------------------------------------

const TEST_SECRET = 'media-batch-secret';
const TEST_AUTH_CODE = 'mediabatchcode';

async function seedUser(
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

async function seedAttachment(
  db: ReturnType<typeof createTestDb>,
  overrides: Partial<typeof schema.contents.$inferInsert> = {},
  authorId = 1,
) {
  const slug = overrides.slug || `attachment-${Date.now()}-${Math.random()}`;
  const meta = JSON.stringify({ path: `uploads/${slug}.jpg`, type: 'image/jpeg', size: 1024 });
  await db.insert(schema.contents).values({
    title: 'Test File',
    slug,
    created: Math.floor(Date.now() / 1000),
    type: 'attachment',
    status: 'publish',
    text: meta,
    authorId,
    ...overrides,
  });
  return (await db.query.contents.findFirst({
    where: (t, { eq }) => eq(t.slug, slug),
  }))!;
}

function makeBatchRequest(
  cids: number[],
  cookieHeader: string,
  action = 'delete',
  referer = 'https://example.com/admin/manage-medias',
): Request {
  const urlStr = `https://example.com/api/admin/media-batch?do=${action}`;
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

describe('POST /api/admin/media-batch', () => {
  beforeEach(() => {
    testDb = createTestDb();
    mockBucketDelete.mockClear();
  });

  // -- Auth guards --

  it('returns 401 when no cookie', async () => {
    await seedUser(testDb);
    const req = makeBatchRequest([1], '');
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not editor', async () => {
    const user = await seedUser(testDb, 'contributor');
    const cookie = await makeAuthCookie(testDb, user.uid);
    const req = makeBatchRequest([1], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(403);
  });

  it('redirects to referer when no cids submitted', async () => {
    const user = await seedUser(testDb);
    const cookie = await makeAuthCookie(testDb, user.uid);
    const req = makeBatchRequest([], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
  });

  // -- delete action --

  it('deletes selected attachment', async () => {
    const user = await seedUser(testDb);
    const cookie = await makeAuthCookie(testDb, user.uid);
    const att = await seedAttachment(testDb, { slug: 'file1' });

    const req = makeBatchRequest([att.cid!], cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(0);
  });

  it('calls R2 BUCKET.delete with the file path', async () => {
    const user = await seedUser(testDb);
    const cookie = await makeAuthCookie(testDb, user.uid);
    const att = await seedAttachment(testDb, { slug: 'r2-file' });
    const meta = JSON.parse(att.text || '{}');

    const req = makeBatchRequest([att.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    expect(mockBucketDelete).toHaveBeenCalledWith(meta.path);
  });

  it('ignores non-attachment content types', async () => {
    const user = await seedUser(testDb);
    const cookie = await makeAuthCookie(testDb, user.uid);
    // Seed a post (not an attachment)
    await testDb.insert(schema.contents).values({
      title: 'Regular Post',
      slug: 'regular-post',
      type: 'post',
      status: 'publish',
      authorId: user.uid,
    });
    const post = (await testDb.query.contents.findFirst())!;

    const req = makeBatchRequest([post.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    // Post should NOT be deleted — type guard must block it
    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(1);
  });

  it('editor can only delete their own attachments', async () => {
    const editor = await seedUser(testDb, 'editor');
    const cookie = await makeAuthCookie(testDb, editor.uid);

    // Attachment owned by uid=99 (different user)
    const att = await seedAttachment(testDb, { slug: 'other-file', authorId: 99 });

    const req = makeBatchRequest([att.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    // File must NOT be deleted — editor does not own it
    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(1);
  });

  it('admin can delete attachments owned by others', async () => {
    const admin = await seedUser(testDb, 'administrator');
    const cookie = await makeAuthCookie(testDb, admin.uid);

    // Attachment owned by uid=99
    const att = await seedAttachment(testDb, { slug: 'foreign-file', authorId: 99 });

    const req = makeBatchRequest([att.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(0);
  });

  it('deletes multiple attachments in one request', async () => {
    const admin = await seedUser(testDb, 'administrator');
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const a1 = await seedAttachment(testDb, { slug: 'multi-a1' });
    const a2 = await seedAttachment(testDb, { slug: 'multi-a2' });
    const a3 = await seedAttachment(testDb, { slug: 'multi-a3' });

    const req = makeBatchRequest([a1.cid!, a2.cid!, a3.cid!], cookie);
    await POST({ request: req, locals: {}, url: new URL(req.url) } as any);

    const remaining = await testDb.select().from(schema.contents);
    expect(remaining).toHaveLength(0);
    expect(mockBucketDelete).toHaveBeenCalledTimes(3);
  });

  it('redirects to referer after delete', async () => {
    const admin = await seedUser(testDb, 'administrator');
    const cookie = await makeAuthCookie(testDb, admin.uid);
    const att = await seedAttachment(testDb, { slug: 'redir-file' });

    const req = makeBatchRequest([att.cid!], cookie, 'delete', 'https://example.com/admin/manage-medias?page=2');
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('manage-medias');
  });
});
