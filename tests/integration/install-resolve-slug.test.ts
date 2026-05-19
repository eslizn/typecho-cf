/**
 * G7-2 / G7-8 regression: install handler must use the IDs that the
 * database actually assigned (via .returning()) rather than hardcoding
 * cid=1/mid=1, and must pick a non-clashing slug if the worker
 * reattaches to a partially populated D1 instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  get env() {
    return {
      DB: {
        batch: async () => [],
        prepare: () => ({ first: async () => null }),
      },
      BUCKET: { delete: vi.fn() },
      INSTALL_TOKEN: undefined,
    };
  },
}));

import { POST } from '@/pages/api/install';

const SITE = 'https://example.com';

function buildInstallRequest(extra: Record<string, string> = {}) {
  return new Request(`${SITE}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      siteTitle: 'Reinstall Site',
      userName: 'admin',
      userPassword: 'secret123',
      userMail: 'admin@example.com',
      ...extra,
    }).toString(),
  });
}

describe('POST /api/install (G7-2 / G7-8)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('uses returned ids and writes a relationship that links the welcome post to the new category', async () => {
    // Pre-seed an unrelated row so the autoincrement counter no longer
    // starts from 1 — proves the install handler is not relying on
    // implicit mid=1 / cid=1.
    await testDb.insert(schema.metas).values({
      name: 'Existing', slug: 'existing', type: 'category', count: 0, order: 1,
    });
    await testDb.insert(schema.contents).values({
      title: 'Existing Post', slug: 'existing-post', type: 'post', status: 'publish', authorId: 0, created: 1,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST({ request: buildInstallRequest(), locals: {} } as any);
    warnSpy.mockRestore();

    expect(res.status).toBe(302);

    // Welcome post should exist and be linked to the *new* category.
    const welcome = await testDb.query.contents.findFirst({
      where: eq(schema.contents.title, '欢迎使用 Typecho'),
    });
    expect(welcome).toBeTruthy();
    expect(welcome!.cid).toBeGreaterThan(1); // not the hardcoded cid=1

    const newCategory = await testDb.query.metas.findFirst({
      where: eq(schema.metas.slug, 'default'),
    });
    expect(newCategory).toBeTruthy();
    expect(newCategory!.mid).toBeGreaterThan(1);

    const rels = await testDb.select().from(schema.relationships);
    const link = rels.find(r => r.cid === welcome!.cid && r.mid === newCategory!.mid);
    expect(link).toBeTruthy();

    // defaultCategory option should track the new mid.
    const defOpt = await testDb.query.options.findFirst({
      where: eq(schema.options.name, 'defaultCategory'),
    });
    expect(defOpt?.value).toBe(String(newCategory!.mid));
  });

  it('appends a numeric suffix when the slug already exists (G7-8)', async () => {
    // Seed an existing post with slug=hello-world to force resolveSlug
    // to pick hello-world-2 for the welcome post.
    await testDb.insert(schema.contents).values({
      title: 'Old', slug: 'hello-world', type: 'post', status: 'publish', authorId: 0, created: 1,
    });
    await testDb.insert(schema.contents).values({
      title: 'OldAbout', slug: 'about', type: 'page', status: 'publish', authorId: 0, created: 1,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST({ request: buildInstallRequest(), locals: {} } as any);
    warnSpy.mockRestore();
    expect(res.status).toBe(302);

    const welcome = await testDb.query.contents.findFirst({
      where: eq(schema.contents.title, '欢迎使用 Typecho'),
    });
    expect(welcome).toBeTruthy();
    expect(welcome!.slug).toBe('hello-world-2');

    const aboutNew = await testDb.query.contents.findFirst({
      where: eq(schema.contents.title, '关于'),
    });
    expect(aboutNew?.slug).toBe('about-2');
  });
});
