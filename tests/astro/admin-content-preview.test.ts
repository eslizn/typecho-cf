/**
 * Behavioral coverage for the authenticated, unsaved content preview route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { generateSecurityToken } from '@/lib/auth';
import * as workerRuntime from 'cloudflare:workers';
import { createTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { renderComponent } from './helpers';

let testDb: TestDatabase;

const testWorkerRuntime = workerRuntime as unknown as {
  caches: typeof globalThis.caches;
  _resetCaches: () => void;
};
(globalThis as any).caches = testWorkerRuntime.caches;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('virtual:theme-templates', async () => {
  const { default: Post } = await import('@/themes/typecho-theme-minimal/components/Post.astro');
  const { default: Page } = await import('@/themes/typecho-theme-minimal/components/Page.astro');
  return {
    themeTemplates: {
      'typecho-theme-minimal': { Post, Page },
    },
  };
});

import ContentPreview from '@/pages/admin/content-preview.astro';

const SECRET = 'preview-secret';
const AUTH_CODE = 'preview-auth-code';

async function makePreviewRequest(
  type: 'post' | 'page',
  fields: Record<string, string> = {},
) {
  const admin = (await testDb.query.users.findFirst())!;
  const cookie = await makeAuthCookie(testDb, admin.uid, AUTH_CODE, SECRET);
  const csrf = await generateSecurityToken(SECRET, AUTH_CODE, admin.uid);
  const body = new URLSearchParams({
    _: csrf,
    type,
    title: type === 'post' ? 'Unsaved post' : 'Unsaved page',
    text: 'Preview body',
    markdown: '1',
    ...fields,
  });
  return new Request('https://example.com/admin/content-preview', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: 'https://example.com',
    },
    body: body.toString(),
  });
}

describe('admin content preview route', () => {
  beforeEach(async () => {
    testWorkerRuntime._resetCaches();
    testDb = await createTestDb();
    await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
    await testDb.insert(schema.options).values({
      name: 'siteUrl', user: 0, value: 'https://example.com',
    });
  });

  it('renders unsaved post content through the active theme without persisting it', async () => {
    const before = await testDb.select().from(schema.contents);
    const html = await renderComponent(ContentPreview, {
      request: await makePreviewRequest('post', { title: 'A <post>', text: 'Body **now**' }),
      locals: {},
    });

    expect(html).toContain('A &lt;post&gt;');
    expect(html).toContain('<strong>now</strong>');
    expect(html).toContain('href="#preview"');
    expect(await testDb.select().from(schema.contents)).toEqual(before);
  });

  it('renders unsaved page content through the active theme', async () => {
    const html = await renderComponent(ContentPreview, {
      request: await makePreviewRequest('page', { title: 'A page' }),
      locals: {},
    });

    expect(html).toContain('A page');
    expect(html).toContain('Preview body');
  });
});
