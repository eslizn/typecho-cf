/**
 * Password-protected content must not leak its body.
 *
 * Regression: toPostListItem rendered the full body as the list excerpt, so a
 * password-protected post published its text (and cached it at the edge) on
 * the index, category, tag, and search archives.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { prepareIndexData, preparePostData } from '@/lib/page-data';
import type { RequestContext } from '@/lib/context';

const SECRET_BODY = 'TOP-SECRET-BODY';
const PASSWORD = 'hunter2';

async function seedProtectedPost(): Promise<number> {
  testDb = await createTestDb();
  const [row] = await testDb.insert(schema.contents).values({
    title: 'Secret post',
    slug: 'secret',
    type: 'post',
    status: 'publish',
    created: 100,
    modified: 100,
    text: SECRET_BODY,
    password: PASSWORD,
  }).returning({ cid: schema.contents.cid });
  return row.cid;
}

describe('password-protected content', () => {
  it('replaces the archive excerpt with the password notice', async () => {
    await seedProtectedPost();
    const ctx = await buildCtx();

    const props = await prepareIndexData(ctx, 'https://example.com/', {}, new URL('https://example.com/'));

    expect(props.posts).toHaveLength(1);
    expect(props.posts[0].excerpt).not.toContain(SECRET_BODY);
    expect(props.posts[0].excerpt).toContain('password');
  });

  it('withholds the body until the password is supplied', async () => {
    const cid = await seedProtectedPost();
    const ctx = await buildCtx();

    const locked = await preparePostData(ctx, cid, 'https://example.com/archives/1/', null);
    expect(locked).not.toBeInstanceOf(Response);
    expect((locked as { post: { content: string } }).post.content).not.toContain(SECRET_BODY);

    const wrong = await preparePostData(ctx, cid, 'https://example.com/archives/1/', 'nope');
    expect((wrong as { post: { content: string } }).post.content).not.toContain(SECRET_BODY);

    const unlocked = await preparePostData(ctx, cid, 'https://example.com/archives/1/', PASSWORD);
    expect((unlocked as { post: { content: string } }).post.content).toContain(SECRET_BODY);
  });
});

async function buildCtx() {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      pageSize: 5,
      categoryPattern: '/category/{slug}/',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      commentsAvatarRating: 'G',
      commentsOrder: 'ASC',
      timezone: 'UTC',
      commentsAntiSpam: 0,
      secret: 'test-secret',
    } as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
    activatedPlugins: new Set<string>(),
  } as unknown as RequestContext;
}
