/**
 * G5-4 upload rate limit and G5-5 hook integration tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateSecurityToken } from '@/lib/auth';
import { resetSlidingWindow } from '@/lib/login-rate-limit';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

const beforeUploadHook = vi.fn(async (value: any) => value);
const uploadHook = vi.fn(async () => {});
const deleteHook = vi.fn(async () => {});

vi.mock('@/lib/plugin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plugin')>('@/lib/plugin');
  return {
    ...actual,
    parseActivatedPlugins: () => [],
    setActivatedPlugins: () => {},
    applyFilter: async (hook: string, value: any, ...args: any[]) => {
      if (hook === 'upload:beforeUpload') return await beforeUploadHook(value, ...args);
      return value;
    },
    doHook: async (hook: string, ...args: any[]) => {
      if (hook === 'upload:upload') await uploadHook(...args);
      else if (hook === 'upload:delete') await deleteHook(...args);
    },
  };
});

const r2Put = vi.fn(async () => {});
const r2Delete = vi.fn(async () => {});

vi.mock('cloudflare:workers', () => ({
  get env() {
    return {
      DB: { batch: async () => [], prepare: () => ({ first: async () => null }) },
      BUCKET: {
        put: r2Put,
        delete: r2Delete,
        get: async () => null,
      },
    };
  },
}));

import { POST, DELETE } from '@/pages/api/admin/upload';

const SITE = 'https://example.com';
const SECRET = 'upload-secret';
const AUTH = 'upload-auth';

async function setUp() {
  testDb = await createTestDb();
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
  await testDb.insert(schema.options).values({ name: 'attachmentTypes', user: 0, value: '@image@' });
  await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
  return await seedAdmin(testDb, { secret: SECRET, authCode: AUTH });
}

async function adminCookie() {
  const user = await testDb.query.users.findFirst();
  return await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
}

async function csrf() {
  const user = await testDb.query.users.findFirst();
  return await generateSecurityToken(SECRET, AUTH, user!.uid);
}

function buildUploadRequest(cookie: string, csrfToken: string) {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'tiny.png', { type: 'image/png' });
  const fd = new FormData();
  fd.set('_', csrfToken);
  fd.set('file', file);
  return new Request(`${SITE}/api/admin/upload`, {
    method: 'POST',
    headers: { cookie, origin: SITE },
    body: fd,
  });
}

describe('upload endpoint (G5-4 + G5-5)', () => {
  beforeEach(async () => {
    await setUp();
    resetSlidingWindow();
    beforeUploadHook.mockReset().mockImplementation(async (v: any) => v);
    uploadHook.mockReset();
    deleteHook.mockReset();
    r2Put.mockReset();
    r2Delete.mockReset();
  });

  it('rate-limits past 60 uploads per minute (G5-4)', async () => {
    const cookie = await adminCookie();
    const csrfToken = await csrf();
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await POST({
        request: buildUploadRequest(cookie, csrfToken),
        locals: {},
      } as any);
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('fires upload:beforeUpload and upload:upload hooks (G5-5)', async () => {
    const cookie = await adminCookie();
    const csrfToken = await csrf();
    const res = await POST({
      request: buildUploadRequest(cookie, csrfToken),
      locals: {},
    } as any);
    expect(res.status).toBe(200);
    expect(beforeUploadHook).toHaveBeenCalledTimes(1);
    expect(uploadHook).toHaveBeenCalledTimes(1);
  });

  it('upload:beforeUpload can reject the upload', async () => {
    beforeUploadHook.mockImplementationOnce(async () => ({ rejected: 'too big' }));
    const cookie = await adminCookie();
    const csrfToken = await csrf();
    const res = await POST({
      request: buildUploadRequest(cookie, csrfToken),
      locals: {},
    } as any);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('too big');
  });

  it('fires upload:delete hook on deletion (G5-5)', async () => {
    const cookie = await adminCookie();
    const csrfToken = await csrf();
    const uploadRes = await POST({
      request: buildUploadRequest(cookie, csrfToken),
      locals: {},
    } as any);
    expect(uploadRes.status).toBe(200);
    const [, info] = await uploadRes.json() as [string, { cid: number }];
    const cid = info.cid;

    const delRes = await DELETE({
      request: new Request(`${SITE}/api/admin/upload?cid=${cid}&_=${csrfToken}`, {
        method: 'DELETE',
        headers: { cookie, origin: SITE },
      }),
      url: new URL(`${SITE}/api/admin/upload?cid=${cid}&_=${csrfToken}`),
      locals: {},
    } as any);
    expect(delRes.status).toBe(200);
    expect(deleteHook).toHaveBeenCalledTimes(1);
  });
});
