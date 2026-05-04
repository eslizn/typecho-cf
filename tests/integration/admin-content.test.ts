/**
 * Integration tests for POST /api/admin/content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb } from '../helpers';
import { generateAuthToken, hashPassword } from '@/lib/auth';
import { eq } from 'drizzle-orm';

let testDb: ReturnType<typeof createTestDb>;

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

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: async (_hook: string, data: any) => data,
  doHook: async () => {},
}));

import { POST } from '@/pages/api/admin/content';

const TEST_SECRET = 'content-secret';
const TEST_AUTH_CODE = 'content-auth-code';

async function seedAdmin() {
  await testDb.insert(schema.options).values({ name: 'secret', user: 0, value: TEST_SECRET });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
  await testDb.insert(schema.users).values({
    name: 'admin',
    password: await hashPassword('admin123'),
    mail: 'admin@example.com',
    group: 'administrator',
    authCode: TEST_AUTH_CODE,
  });
  return (await testDb.query.users.findFirst())!;
}

async function makeAuthCookie(uid: number) {
  const token = await generateAuthToken(uid, TEST_AUTH_CODE, TEST_SECRET);
  const [uidPart, hash] = token.split(':');
  return `__typecho_uid=${uidPart}; __typecho_authCode=${hash}`;
}

async function makeContentRequest(fields: Record<string, string>, cookie: string) {
  const body = new URLSearchParams(fields);
  return new Request('https://example.com/api/admin/content', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
    },
    body: body.toString(),
  });
}

describe('POST /api/admin/content', () => {
  beforeEach(async () => {
    testDb = createTestDb();
    await seedAdmin();
  });

  it('counts duplicate tag names once when creating content', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(admin!.uid);
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
});
