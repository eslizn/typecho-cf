import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Client, InStatement, InValue } from '@libsql/client';
import * as schema from '@/db/schema';
import * as workerRuntime from 'cloudflare:workers';
import AdminDashboard from '@/pages/admin/index.astro';
import ManageComments from '@/pages/admin/manage-comments.astro';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { renderComponent } from './helpers';

const runtime = workerRuntime as unknown as { caches: typeof globalThis.caches; _resetCaches: () => void };
(globalThis as any).caches = runtime.caches;

let testDb: TestDatabase;
let cookie: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => actual.getDb(createReadBinding(testDb.$client)) };
});

function createReadBinding(client: Client): D1Database {
  return {
    prepare(sql: string) {
      const bind = (...args: InValue[]) => {
        const statement = { sql, args };
        return {
          statement,
          bind,
          async raw() {
            const { columns, rows } = await client.execute(statement);
            return rows.map(row => columns.map((_, index) => row[index]));
          },
        };
      };
      return bind();
    },
    async batch(prepared: { statement: InStatement }[]) {
      const results = await client.batch(prepared.map(({ statement }) => statement), 'read');
      // D1 batch rows are keyed by SQL column name. Later duplicate names
      // replace earlier values before the Drizzle D1 driver reads the row.
      return results.map(({ columns, rows }) => ({
        results: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
      }));
    },
  } as unknown as D1Database;
}

beforeEach(async () => {
  runtime._resetCaches();
  testDb = await createTestDb();
  const secret = 'comment-dates-secret';
  const authCode = 'comment-dates-auth-code';
  const admin = await seedAdmin(testDb, { secret, authCode });
  cookie = await makeAuthCookie(testDb, admin.uid, authCode, secret);
  await testDb.insert(schema.options).values([
    { name: 'siteUrl', user: 0, value: 'https://example.com' },
    { name: 'timezone', user: 0, value: 'Asia/Shanghai' },
    { name: 'permalinkPattern', user: 0, value: '/{year}/{month}/{day}/{slug}/' },
  ]);
  const [post] = await testDb.insert(schema.contents).values({
    title: 'Older post', slug: 'older-post', authorId: admin.uid, created: 1_551_410_400,
  }).returning({ cid: schema.contents.cid });
  await testDb.insert(schema.comments).values([
    { coid: 1, cid: post!.cid, author: 'Alice', text: 'Spam reply', status: 'spam', created: 1_795_163_062 },
    { coid: 2, cid: post!.cid, author: 'Bob', text: 'Approved reply', status: 'approved', created: 1_795_163_062 },
  ]);
});

afterEach(async () => { await disposeTestDb(testDb); });

it('shows the spam comment submission time and links to the dated post', async () => {
  const html = await renderComponent(ManageComments, {
    request: new Request('https://example.com/admin/manage-comments?status=spam', { headers: { cookie } }),
  });

  expect(html.match(/class="comment-date">\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1]).toBe('2026-11-20 16:24');
  expect(html).toContain('href="https://example.com/2019/03/01/older-post/"');
});

it('shows the recent comment submission date and links to the dated post', async () => {
  const html = await renderComponent(AdminDashboard, {
    request: new Request('https://example.com/admin/', { headers: { cookie } }),
  });

  expect(html.match(/<span>([\d.]+)<\/span>\s*<a href="[^"]+#comment-2"/)?.[1]).toBe('11.20');
  expect(html).toContain('href="https://example.com/2019/03/01/older-post/#comment-2"');
});
