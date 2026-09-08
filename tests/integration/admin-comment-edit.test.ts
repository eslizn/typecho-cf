import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let db: TestDatabase;
const { filter, hook } = vi.hoisted(() => ({
  filter: vi.fn(async (_ctx: any, _point: string, value: any) => value),
  hook: vi.fn(async () => {}),
}));
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => db, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});
vi.mock('@/lib/plugin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plugin')>('@/lib/plugin');
  return { ...actual, applyFilter: filter, doHook: hook };
});
import { POST } from '@/pages/api/admin/comment';

const secret = 'comment-edit-secret';
const authCode = 'comment-edit-code';
async function request(fields: Record<string, string>, cookie: string, origin = 'https://example.com') {
  return new Request('https://example.com/api/admin/comment', { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie, origin,
  }, body: new URLSearchParams(fields).toString() });
}

describe('POST /api/admin/comment', () => {
  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db, { secret, authCode });
    await db.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
    filter.mockImplementation(async (_ctx: any, _point: string, value: any) => value);
    hook.mockClear();
  });

  async function seedComment(authorId = 1) {
    const [post] = await db.insert(schema.contents).values({ title: 'Post', slug: `post-${authorId}`, type: 'post', status: 'publish', authorId }).returning();
    const [comment] = await db.insert(schema.comments).values({ cid: post.cid, author: 'Old', mail: 'old@example.com', url: '', text: 'Old text', status: 'approved', ownerId: authorId }).returning();
    return comment;
  }

  it('edits author, contact fields and body while preserving moderation status', async () => {
    const comment = await seedComment();
    const admin = await db.query.users.findFirst();
    const cookie = await makeAuthCookie(db, admin!.uid, authCode, secret);
    const res = await POST({ request: await request({ coid: String(comment.coid), author: 'New', mail: 'new@example.com', url: 'https://new.test', text: 'New text' }, cookie), url: new URL('https://example.com/api/admin/comment') } as any);
    expect(res.status).toBe(302);
    expect(await db.query.comments.findFirst({ where: eq(schema.comments.coid, comment.coid) })).toMatchObject({ author: 'New', mail: 'new@example.com', url: 'https://new.test', text: 'New text', status: 'approved' });
  });

  it.each([
    ['missing comment', '999', '页面不存在'],
    ['empty author', '1', '作者和内容不能为空'],
  ])('rejects %s', async (_name, coid, expected) => {
    const comment = await seedComment();
    const admin = await db.query.users.findFirst();
    const cookie = await makeAuthCookie(db, admin!.uid, authCode, secret);
    const res = await POST({ request: await request({ coid: coid === '1' ? String(comment.coid) : coid, author: '', mail: '', url: '', text: 'x' }, cookie), url: new URL('https://example.com/api/admin/comment') } as any);
    expect(res.status).toBe(coid === '1' ? 400 : 404);
    expect(await res.text()).toContain(expected);
  });

  it('rejects a non-owner editor and cross-origin requests', async () => {
    const comment = await seedComment(3);
    const [editor] = await db.insert(schema.users).values({ name: 'editor', password: 'hash', mail: 'editor@example.com', group: 'editor', authCode: 'editor-code' }).returning();
    const cookie = await makeAuthCookie(db, editor.uid, 'editor-code', secret);
    const forbidden = await POST({ request: await request({ coid: String(comment.coid), author: 'x', text: 'x' }, cookie), url: new URL('https://example.com/api/admin/comment') } as any);
    expect(forbidden.status).toBe(403);
    const crossOrigin = await POST({ request: await request({ coid: String(comment.coid), author: 'x', text: 'x' }, cookie, 'https://evil.example'), url: new URL('https://example.com/api/admin/comment') } as any);
    expect(crossOrigin.status).toBe(403);
  });

  it('does not allow a filter to change protected comment identity fields', async () => {
    const comment = await seedComment();
    filter.mockImplementationOnce(async (_ctx: any, _point: string, value: any) => ({ ...value, cid: 999, ownerId: 999, status: 'waiting', author: 'Filtered' }));
    const admin = await db.query.users.findFirst();
    const cookie = await makeAuthCookie(db, admin!.uid, authCode, secret);
    await POST({ request: await request({ coid: String(comment.coid), author: 'x', text: 'x' }, cookie), url: new URL('https://example.com/api/admin/comment') } as any);
    const saved = await db.query.comments.findFirst({ where: eq(schema.comments.coid, comment.coid) });
    expect(saved).toMatchObject({ cid: comment.cid, ownerId: comment.ownerId, status: 'approved', author: 'Filtered' });
  });
});
