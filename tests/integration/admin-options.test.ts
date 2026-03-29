/**
 * Integration tests for POST /api/admin/options
 *
 * Tests admin settings save, checkbox handling, unit conversions,
 * permalink pattern handling, and access control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { hashPassword, generateAuthToken } from '@/lib/auth';

// ---- shared DB ref (mutated in beforeEach) ----------------------------------

let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return {
    ...actual,
    getDb: (_d1: any) => testDb,
    schema: actual.schema,
  };
});

import { POST } from '@/pages/api/admin/options';

// ---- helpers ----------------------------------------------------------------

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
  `);
  return drizzle(sqlite, { schema });
}

const TEST_SECRET = 'test-secret-admin';
const TEST_AUTH_CODE = 'adminauthcode123';

async function seedAdmin(db: ReturnType<typeof createTestDb>) {
  await db.insert(schema.options).values({ name: 'secret', user: 0, value: TEST_SECRET });
  await db.insert(schema.users).values({
    name: 'admin',
    password: await hashPassword('admin123'),
    mail: 'admin@example.com',
    group: 'administrator',
    authCode: TEST_AUTH_CODE,
  });
}

async function makeAdminRequest(
  db: ReturnType<typeof createTestDb>,
  formFields: Record<string, string>,
  referer = 'https://example.com/admin/options-general',
): Promise<Request> {
  const admin = await db.query.users.findFirst();
  const token = await generateAuthToken(admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
  const [uid, hash] = token.split(':');
  const cookieHeader = `__typecho_uid=${uid}; __typecho_authCode=${hash}`;

  const body = new URLSearchParams(formFields);
  return new Request('https://example.com/api/admin/options', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': cookieHeader,
      'referer': referer,
    },
    body: body.toString(),
  });
}

async function getOption(db: ReturnType<typeof createTestDb>, name: string) {
  const row = await db.query.options.findFirst({
    where: (t, { eq, and }) => and(eq(t.name, name), eq(t.user, 0)),
  });
  return row?.value ?? null;
}

// ---- tests ------------------------------------------------------------------

describe('POST /api/admin/options', () => {
  beforeEach(async () => {
    testDb = createTestDb();
    await seedAdmin(testDb);
  });

  // -- Access control --

  it('returns 401 when no cookie is sent', async () => {
    const req = new Request('https://example.com/api/admin/options', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Test',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not administrator', async () => {
    // Insert a non-admin user
    await testDb.insert(schema.users).values({
      name: 'editor',
      password: 'hash',
      mail: 'editor@example.com',
      group: 'editor',
      authCode: 'editorcode',
    });
    const editorUser = await testDb.query.users.findFirst({
      where: (t, { eq }) => eq(t.name, 'editor'),
    });
    const token = await generateAuthToken(editorUser!.uid, 'editorcode', TEST_SECRET);
    const [uid, hash] = token.split(':');
    const req = new Request('https://example.com/api/admin/options', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': `__typecho_uid=${uid}; __typecho_authCode=${hash}`,
        'referer': 'https://example.com/admin/options-general',
      },
      body: 'title=Forbidden',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  // -- Basic settings save --

  it('saves site title', async () => {
    const req = await makeAdminRequest(testDb, { title: 'My Awesome Blog' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(await getOption(testDb, 'title')).toBe('My Awesome Blog');
  });

  it('saves siteUrl', async () => {
    const req = await makeAdminRequest(testDb, { siteUrl: 'https://myblog.com' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(await getOption(testDb, 'siteUrl')).toBe('https://myblog.com');
  });

  // -- Unit conversions --

  it('converts commentsPostTimeout from days to seconds', async () => {
    const req = await makeAdminRequest(
      testDb,
      { commentsPostTimeout: '7' },
      'https://example.com/admin/options-discussion',
    );
    await POST({ request: req, locals: {} } as any);
    const val = await getOption(testDb, 'commentsPostTimeout');
    expect(val).toBe(String(7 * 24 * 3600)); // 604800
  });

  it('converts commentsPostInterval from minutes to seconds', async () => {
    const req = await makeAdminRequest(
      testDb,
      { commentsPostInterval: '5' },
      'https://example.com/admin/options-discussion',
    );
    await POST({ request: req, locals: {} } as any);
    const val = await getOption(testDb, 'commentsPostInterval');
    expect(val).toBe(String(5 * 60)); // 300
  });

  it('defaults commentsPostTimeout to 14 days when value is invalid', async () => {
    const req = await makeAdminRequest(
      testDb,
      { commentsPostTimeout: 'abc' },
      'https://example.com/admin/options-discussion',
    );
    await POST({ request: req, locals: {} } as any);
    const val = await getOption(testDb, 'commentsPostTimeout');
    expect(val).toBe(String(14 * 24 * 3600));
  });

  // -- Permalink patterns --

  it('saves a preset permalinkPattern', async () => {
    const req = await makeAdminRequest(
      testDb,
      { permalinkPattern: '/archives/{slug}.html' },
      'https://example.com/admin/options-permalink',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'permalinkPattern')).toBe('/archives/{slug}.html');
  });

  it('uses customPattern when permalinkPattern is "custom"', async () => {
    const req = await makeAdminRequest(
      testDb,
      { permalinkPattern: 'custom', customPattern: '/{year}/{month}/{slug}/' },
      'https://example.com/admin/options-permalink',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'permalinkPattern')).toBe('/{year}/{month}/{slug}/');
  });

  it('falls back to /archives/{cid}/ when custom pattern is empty', async () => {
    const req = await makeAdminRequest(
      testDb,
      { permalinkPattern: 'custom', customPattern: '' },
      'https://example.com/admin/options-permalink',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'permalinkPattern')).toBe('/archives/{cid}/');
  });

  it('saves pagePattern', async () => {
    const req = await makeAdminRequest(
      testDb,
      { pagePattern: '/pages/{slug}/' },
      'https://example.com/admin/options-permalink',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'pagePattern')).toBe('/pages/{slug}/');
  });

  it('saves categoryPattern', async () => {
    const req = await makeAdminRequest(
      testDb,
      { categoryPattern: '/cat/{slug}/' },
      'https://example.com/admin/options-permalink',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'categoryPattern')).toBe('/cat/{slug}/');
  });

  // -- Checkbox handling (unchecked = absent from form data) --

  it('sets allowRegister to 0 when checkbox is absent (general page)', async () => {
    // First set it to 1
    await testDb.insert(schema.options).values({ name: 'allowRegister', user: 0, value: '1' });

    // Submit without the checkbox field (unchecked)
    const req = await makeAdminRequest(
      testDb,
      { title: 'Test' },
      'https://example.com/admin/options-general',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'allowRegister')).toBe('0');
  });

  it('sets commentsRequireMail to 0 when absent (discussion page)', async () => {
    await testDb.insert(schema.options).values({ name: 'commentsRequireMail', user: 0, value: '1' });

    const req = await makeAdminRequest(
      testDb,
      { commentsListSize: '10' },
      'https://example.com/admin/options-discussion',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'commentsRequireMail')).toBe('0');
  });

  it('does NOT clear discussion checkboxes when general page is submitted', async () => {
    await testDb.insert(schema.options).values({ name: 'commentsRequireMail', user: 0, value: '1' });

    // Submit general page — should NOT touch commentsRequireMail
    const req = await makeAdminRequest(
      testDb,
      { title: 'General Page Submit' },
      'https://example.com/admin/options-general',
    );
    await POST({ request: req, locals: {} } as any);
    // commentsRequireMail should remain untouched
    expect(await getOption(testDb, 'commentsRequireMail')).toBe('1');
  });

  it('sets feedFullText to 0 when absent (reading page)', async () => {
    await testDb.insert(schema.options).values({ name: 'feedFullText', user: 0, value: '1' });

    const req = await makeAdminRequest(
      testDb,
      { pageSize: '10' },
      'https://example.com/admin/options-reading',
    );
    await POST({ request: req, locals: {} } as any);
    expect(await getOption(testDb, 'feedFullText')).toBe('0');
  });

  // -- Redirect --

  it('redirects back to referer after saving', async () => {
    const req = await makeAdminRequest(
      testDb,
      { title: 'Test' },
      'https://example.com/admin/options-general',
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/admin/options-general');
  });
});
