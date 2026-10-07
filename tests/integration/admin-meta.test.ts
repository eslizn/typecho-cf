/**
 * Integration tests for POST /api/admin/meta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST, GET } from '@/pages/api/admin/meta';

const SECRET = 'test-secret-m';
const AUTH_CODE = 'authcodemeta';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

function makeAdminReq(path: string, formFields: Record<string, string>, cookie: string): Request {
  const formData = new URLSearchParams(formFields);
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' },
    body: formData.toString(),
  });
}

describe('POST /api/admin/meta', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/meta?action=create&type=category', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Test',
    });
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('creates a new category', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', { name: 'Technology' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.name, 'Technology'),
    });
    expect(meta).not.toBeNull();
    expect(meta!.type).toBe('category');
    expect(meta!.slug).toBe('technology');
  });

  it('creates a new tag', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=tag', { name: 'JavaScript' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.name, 'JavaScript'),
    });
    expect(meta).not.toBeNull();
    expect(meta!.type).toBe('tag');
  });

  it('rejects create with empty name', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', { name: '' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported meta type writes', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=link', { name: 'Bad Type' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });

  it('updates an existing meta', async () => {
    await testDb.insert(schema.metas).values({ name: 'Old', slug: 'old', type: 'category' });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta', { action: 'update', type: 'category', mid: '1', name: 'Updated' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.mid, 1),
    });
    expect(meta!.name).toBe('Updated');
  });

  it('deletes a meta and its relationships', async () => {
    await testDb.insert(schema.metas).values({ name: 'Temp', slug: 'temp', type: 'tag' });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta', { action: 'delete', type: 'tag', mid: '1' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);

    const meta = await testDb.query.metas.findFirst({
      where: (t, { eq }) => eq(t.mid, 1),
    });
    expect(meta).toBeUndefined();
  });

  it('returns 400 for invalid action', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta', { action: 'invalid', type: 'category' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });

  it('redirects to manage-categories for categories', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=category', { name: 'Cat' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/manage-categories');
  });

  it('redirects to manage-tags for tags', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq('/api/admin/meta?action=create&type=tag', { name: 'Tag' }, cookie);
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/manage-tags');
  });
});

describe('GET /api/admin/meta', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/meta');
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns JSON list of categories', async () => {
    await testDb.insert(schema.metas).values({ name: 'Cat1', slug: 'cat1', type: 'category', count: 0 });
    await testDb.insert(schema.metas).values({ name: 'Cat2', slug: 'cat2', type: 'category', count: 5 });

    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/meta', { headers: { cookie } });
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);

    const body = await res.json<Array<{ name: string }>>();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe('Cat1');
    expect(body[1].name).toBe('Cat2');
  });

  it('rejects unsupported meta types on GET', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/meta?type=link', { headers: { cookie } });
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/meta batch + default', () => {
  it('recounts only matching metadata and excludes revision relationships', async () => {
    const [category, tag] = await testDb.insert(schema.metas).values([
      { name: 'Category', slug: 'recount-category', type: 'category', count: 99 },
      { name: 'Tag', slug: 'recount-tag', type: 'tag', count: 5 },
    ]).returning();
    const [post] = await testDb.insert(schema.contents).values({ title: 'Parent', slug: 'recount-post', type: 'post', status: 'publish', authorId: 1 }).returning();
    const [revision] = await testDb.insert(schema.contents).values({ title: 'Revision', slug: post.slug, type: 'revision', status: 'draft', parent: post.cid, authorId: 1 }).returning();
    await testDb.insert(schema.relationships).values([{ cid: post.cid, mid: category.mid }, { cid: revision.cid, mid: category.mid }]);
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const body = new URLSearchParams({ action: 'refresh', type: 'category' });
    body.append('mid[]', String(category.mid));
    body.append('mid[]', String(tag.mid));
    const request = new Request('https://example.com/api/admin/meta', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://example.com' }, body,
    });
    expect((await POST({ request, locals: {}, url: new URL(request.url) } as any)).status).toBe(302);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))!.count).toBe(1);
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, tag.mid) }))!.count).toBe(5);
  });

  it('deletes selected mid[] from a form POST', async () => {
    await testDb.insert(schema.metas).values([
      { name: 'A', slug: 'a', type: 'tag', count: 0 },
      { name: 'B', slug: 'b', type: 'tag', count: 0 },
    ]);
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const body = new URLSearchParams();
    body.append('action', 'delete');
    body.append('type', 'tag');
    body.append('mid[]', '1');
    body.append('mid[]', '2');
    const req = new Request('https://example.com/api/admin/meta', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
        origin: 'https://example.com',
      },
      body: body.toString(),
    });
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    const remaining = await testDb.select().from(schema.metas).where(eq(schema.metas.type, 'tag'));
    expect(remaining).toHaveLength(0);
  });

  it('sets the default category via POST', async () => {
    await testDb.insert(schema.metas).values({ name: 'Primary', slug: 'primary', type: 'category', count: 0 });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq(
      '/api/admin/meta?action=default&mid=1&type=category',
      {},
      cookie,
    );
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(302);
    const row = await testDb.query.options.findFirst({
      where: (t, { eq, and }) => and(eq(t.name, 'defaultCategory'), eq(t.user, 0)),
    });
    expect(row?.value).toBe('1');
  });

  it('rejects default when mid is not a category', async () => {
    await testDb.insert(schema.metas).values({ name: 'OnlyTag', slug: 'only-tag', type: 'tag', count: 0 });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq(
      '/api/admin/meta?action=default&mid=1&type=category',
      {},
      cookie,
    );
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(404);
  });

  it('rejects update when mid type does not match', async () => {
    await testDb.insert(schema.metas).values({ name: 'TagOnly', slug: 'tag-only', type: 'tag', count: 0 });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = makeAdminReq(
      '/api/admin/meta',
      { action: 'update', type: 'category', mid: '1', name: 'Nope' },
      cookie,
    );
    const res = await POST({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(404);
  });
});
