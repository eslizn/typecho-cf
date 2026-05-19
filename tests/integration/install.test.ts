/**
 * Integration tests for POST /api/install
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

const mockD1 = {
  batch: vi.fn(async (stmts: any[]) => {
    for (const stmt of stmts) {
      // Each stmt is { query: string, params: any[] } from d1.prepare()
    }
  }),
} as any;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));

vi.mock('cloudflare:workers', () => ({
  env: { DB: null, BUCKET: null },
}));

import { POST } from '@/pages/api/install';

beforeEach(async () => {
  testDb = await createTestDb();
  // Simulate clean DB (drop pre-created tables for install test)
  for (const table of ['typecho_fields', 'typecho_relationships', 'typecho_comments', 'typecho_contents', 'typecho_metas', 'typecho_options', 'typecho_users']) {
    try { await testDb.run(`DROP TABLE IF EXISTS \`${table}\``); } catch {}
  }
  mockD1.batch = vi.fn(async (stmts: any[]) => {
    for (const stmt of stmts) {
      try { await testDb.run(stmt); } catch {}
    }
  });
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('POST /api/install', () => {
  it('rejects incomplete form data', async () => {
    const formData = new FormData();
    formData.set('siteTitle', 'My Blog');
    const request = new Request('https://example.com/api/install', {
      method: 'POST',
      body: formData,
    });
    const response = await POST({ request, locals: {}, url: new URL(request.url) } as any);
    expect(response.status).toBe(400);
  });

  it('rejects short password', async () => {
    const formData = new FormData();
    formData.set('userName', 'admin');
    formData.set('userPassword', '12345');
    formData.set('userMail', 'admin@example.com');
    const request = new Request('https://example.com/api/install', {
      method: 'POST',
      body: formData,
    });
    const response = await POST({ request, locals: {}, url: new URL(request.url) } as any);
    expect(response.status).toBe(400);
  });

  it('returns error response message for short password', async () => {
    const formData = new FormData();
    formData.set('userName', 'admin');
    formData.set('userPassword', 'a');
    formData.set('userMail', 'admin@example.com');
    const request = new Request('https://example.com/api/install', { method: 'POST', body: formData });
    const response = await POST({ request, locals: {}, url: new URL(request.url) } as any);
    expect(response.status).toBe(400);
  });
});
