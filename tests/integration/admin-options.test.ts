/**
 * Integration tests for POST /api/admin/options
 *
 * Tests admin settings save, checkbox handling, unit conversions,
 * permalink pattern handling, and access control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, type TestDatabase } from '../helpers';
import { generateAuthToken } from '@/lib/auth';

// ---- shared DB ref (mutated in beforeEach) ----------------------------------

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

import { POST } from '@/pages/api/admin/options';

// ---- helpers ----------------------------------------------------------------


const TEST_SECRET = 'test-secret-admin';
const TEST_AUTH_CODE = 'adminauthcode123';

async function makeAdminRequest(
  db: TestDatabase,
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

async function getOption(db: TestDatabase, name: string) {
  const row = await db.query.options.findFirst({
    where: (t, { eq, and }) => and(eq(t.name, name), eq(t.user, 0)),
  });
  return row?.value ?? null;
}

// ---- tests ------------------------------------------------------------------

describe('POST /api/admin/options', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
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

  it('persists one form as one cache-version change', async () => {
    const req = await makeAdminRequest(testDb, {
      title: 'Batch title',
      description: 'Batch description',
      allowRegister: '1',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(await getOption(testDb, 'title')).toBe('Batch title');
    expect(await getOption(testDb, 'description')).toBe('Batch description');
    expect(await getOption(testDb, 'cacheVersion')).toBe('1');
  });

  it('saves siteUrl', async () => {
    const req = await makeAdminRequest(testDb, { siteUrl: 'https://myblog.com' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(await getOption(testDb, 'siteUrl')).toBe('https://myblog.com');
  });

  it('saves an IANA timezone identifier', async () => {
    const req = await makeAdminRequest(testDb, { timezone: 'America/New_York' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(await getOption(testDb, 'timezone')).toBe('America/New_York');
  });

  it('rejects numeric timezone values without partially saving', async () => {
    const req = await makeAdminRequest(testDb, {
      timezone: '28800',
      title: 'must-not-save',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    expect(await getOption(testDb, 'timezone')).toBeNull();
    expect(await getOption(testDb, 'title')).toBeNull();
  });

  it('rejects a valid but unregistered locale without partially saving', async () => {
    const req = await makeAdminRequest(testDb, {
      lang: 'fr-FR',
      title: 'must-not-save',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    expect(await getOption(testDb, 'lang')).toBeNull();
    expect(await getOption(testDb, 'title')).toBeNull();
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

  it('rejects invalid commentsPostTimeout without partially saving the form', async () => {
    const req = await makeAdminRequest(
      testDb,
      { title: 'must-not-save', commentsPostTimeout: 'abc' },
      'https://example.com/admin/options-discussion',
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    expect(await getOption(testDb, 'title')).toBeNull();
    expect(await getOption(testDb, 'commentsPostTimeout')).toBeNull();
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

  it('rejects invalid permalink patterns without changing existing settings', async () => {
    await testDb.insert(schema.options).values({ name: 'pagePattern', user: 0, value: '/{slug}.html' });
    const req = await makeAdminRequest(
      testDb,
      { title: 'must-not-save', pagePattern: '/pages/{year}/' },
      'https://example.com/admin/options-permalink',
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    expect(await getOption(testDb, 'title')).toBeNull();
    expect(await getOption(testDb, 'pagePattern')).toBe('/{slug}.html');
  });

  it('rejects an oversized declared body before parsing', async () => {
    const req = await makeAdminRequest(testDb, { title: 'must-not-save' });
    req.headers.set('content-length', String(256 * 1024 + 1));
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(413);
    expect(await getOption(testDb, 'title')).toBeNull();
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
    expect(res.headers.get('location')).toBe('/admin/options-general');
  });
});
