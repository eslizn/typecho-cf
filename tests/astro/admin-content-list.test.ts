import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import * as workerRuntime from 'cloudflare:workers';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { renderComponent } from './helpers';

let testDb: TestDatabase;
const runtime = workerRuntime as unknown as { caches: typeof globalThis.caches; _resetCaches: () => void };
(globalThis as any).caches = runtime.caches;
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});

import ManagePosts from '@/pages/admin/manage-posts.astro';
import ManagePages from '@/pages/admin/manage-pages.astro';

const SECRET = 'list-secret';
const AUTH_CODE = 'list-auth-code';

beforeEach(async () => {
  runtime._resetCaches();
  testDb = await createTestDb();
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
});
afterEach(async () => { await disposeTestDb(testDb); });

async function seedList(group: string) {
  const user = await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE, group });
  await testDb.insert(schema.users).values({ name: 'other', mail: 'other@example.com', group: 'contributor' });
  await testDb.insert(schema.contents).values([
    { title: 'Own published post', slug: 'own-list-post', type: 'post', status: 'publish', authorId: user.uid },
    { title: 'Other published post', slug: 'other-list-post', type: 'post', status: 'publish', authorId: 2 },
    { title: 'Own draft post', slug: 'own-list-draft', type: 'post_draft', status: 'draft', authorId: user.uid },
    { title: 'Other draft post', slug: 'other-list-draft', type: 'post_draft', status: 'draft', authorId: 2 },
    { title: 'Own waiting post', slug: 'own-list-waiting', type: 'post', status: 'waiting', authorId: user.uid },
    { title: 'Other waiting post', slug: 'other-list-waiting', type: 'post', status: 'waiting', authorId: 2 },
    { title: 'Other published page', slug: 'other-list-page', type: 'page', status: 'publish', authorId: 2 },
  ]);
  return makeAuthCookie(testDb, user.uid, AUTH_CODE, SECRET);
}

describe('admin content list permissions', () => {
  it.each(['administrator', 'editor', 'contributor'])('scopes %s post lists and draft/waiting totals', async (group) => {
    const cookie = await seedList(group);
    const allAuthors = group !== 'contributor';
    const expectedCount = allAuthors ? 2 : 1;
    for (const [status, title] of [['', 'published'], ['draft', 'draft'], ['waiting', 'waiting']]) {
      const html = await renderComponent(ManagePosts, {
        request: new Request(`https://example.com/admin/manage-posts${status ? `?status=${status}` : ''}`, { headers: { cookie } }), locals: {},
      });
      expect(html).toContain(`Own ${title} post`);
      if (allAuthors) expect(html).toContain(`Other ${title} post`);
      else expect(html).not.toContain(`Other ${title} post`);
      for (const tab of ['draft', 'waiting']) {
        expect(html).toMatch(new RegExp(`href="/admin/manage-posts\\?status=${tab}"[^>]*>[\\s\\S]*?<span class="balloon">${expectedCount}</span>`));
      }
    }
  });

  it('lets an editor filter the shared post list by author', async () => {
    const cookie = await seedList('editor');
    const html = await renderComponent(ManagePosts, {
      request: new Request('https://example.com/admin/manage-posts?uid=2', { headers: { cookie } }), locals: {},
    });
    expect(html).toContain('Other published post');
    expect(html).not.toContain('Own published post');
  });

  it('shows another author page to an editor', async () => {
    const cookie = await seedList('editor');
    const html = await renderComponent(ManagePages, {
      request: new Request('https://example.com/admin/manage-pages', { headers: { cookie } }), locals: {},
    });
    expect(html).toContain('Other published page');
  });
});
