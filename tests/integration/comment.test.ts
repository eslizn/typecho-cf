/**
 * Integration tests for POST /api/comment
 *
 * Tests the comment submission flow including validation, anti-spam,
 * auth checks, and auto-close enforcement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb } from '../helpers';
import { generateCommentToken } from '@/lib/auth';

// We need to intercept the module-level `getDb(env.DB)` call inside comment.ts
// by mocking the `@/db` module so it returns our in-memory DB.
let testDb: ReturnType<typeof createTestDb>;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return {
    ...actual,
    getDb: (_d1: any) => testDb,
    schema: actual.schema,
  };
});

// Mock plugin module to be a no-op in tests
vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: async (hook: string, data: any) => data,
  doHook: async () => {},
}));

import { POST } from '@/pages/api/comment';

// ---- test helpers -----------------------------------------------------------

async function seedContent(
  db: ReturnType<typeof createTestDb>,
  overrides: Partial<typeof schema.contents.$inferInsert> = {},
) {
  await db.insert(schema.contents).values({
    title: 'Test Post',
    slug: 'test-post',
    created: Math.floor(Date.now() / 1000) - 100,
    type: 'post',
    status: 'publish',
    allowComment: '1',
    ...overrides,
  });
  const row = await db.query.contents.findFirst();
  return row!;
}

async function seedOptions(
  db: ReturnType<typeof createTestDb>,
  opts: Record<string, string> = {},
) {
  const defaults: Record<string, string> = {
    secret: 'test-secret',
    commentsRequireMail: '0',
    commentsRequireURL: '0',
    commentsPostIntervalEnable: '0',
    commentsRequireModeration: '0',
    commentsWhitelist: '0',
    commentsAutoClose: '0',
    commentsCheckReferer: '0',
    commentsAntiSpam: '0',
    ...opts,
  };
  for (const [name, value] of Object.entries(defaults)) {
    await db.insert(schema.options).values({ name, user: 0, value });
  }
}

function makeCommentRequest(
  formFields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const body = new URLSearchParams(formFields);
  return new Request('https://example.com/api/comment', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'TestAgent/1.0',
      'referer': 'https://example.com/',
      ...headers,
    },
    body: body.toString(),
  });
}

// ---- tests ------------------------------------------------------------------

describe('POST /api/comment', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it('returns 400 when cid is missing', async () => {
    await seedOptions(testDb);
    const req = makeCommentRequest({ text: 'Hello' });
    const ctx = { request: req, locals: {} } as any;
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is empty', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: '' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 404 when content does not exist', async () => {
    await seedOptions(testDb);
    const req = makeCommentRequest({ cid: '9999', text: 'Hello', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(404);
  });

  it('returns 403 when comments are closed on content', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { allowComment: '0' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hi', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('returns 403 when content is password-protected', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { password: 'secret123' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hi', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('returns 400 when author is missing for anonymous user', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hello' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when mail is required but missing', async () => {
    await seedOptions(testDb, { commentsRequireMail: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Hello', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
  });

  it('returns 302 redirect on successful comment', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Great post!',
      author: 'Alice',
      mail: 'alice@example.com',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('#comments');
  });

  it('stores comment with correct IP from CF-Connecting-IP', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'From CF!', author: 'Bob' },
      { 'cf-connecting-ip': '1.2.3.4' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const comment = await testDb.query.comments.findFirst();
    expect(comment?.ip).toBe('1.2.3.4');
  });

  it('stores only first IP from X-Forwarded-For', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Via proxy!', author: 'Carol' },
      { 'x-forwarded-for': '10.0.0.1, 172.16.0.1, 192.168.1.1' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const comment = await testDb.query.comments.findFirst();
    expect(comment?.ip).toBe('10.0.0.1');
  });

  it('returns 429 when same IP posts too quickly (commentsPostIntervalEnable)', async () => {
    await seedOptions(testDb, {
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',  // 60 seconds
    });
    const content = await seedContent(testDb);

    // Insert a recent comment from the same IP
    await testDb.insert(schema.comments).values({
      cid: content.cid,
      created: Math.floor(Date.now() / 1000) - 5, // 5 seconds ago
      author: 'Spammer',
      ip: '5.5.5.5',
      text: 'spam',
      status: 'approved',
      type: 'comment',
      parent: 0,
    });

    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Too fast!', author: 'Spammer' },
      { 'cf-connecting-ip': '5.5.5.5' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(429);
  });

  it('enforces commentsAutoClose when article is too old', async () => {
    await seedOptions(testDb, {
      commentsAutoClose: '1',
      commentsPostTimeout: '86400', // 1 day in seconds
    });
    // Content created 2 days ago
    const content = await seedContent(testDb, {
      created: Math.floor(Date.now() / 1000) - 2 * 86400,
    });
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Old post comment',
      author: 'Dave',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('文章发布时间过长');
  });

  it('does not enforce autoClose when article is recent enough', async () => {
    await seedOptions(testDb, {
      commentsAutoClose: '1',
      commentsPostTimeout: '86400', // 1 day in seconds
    });
    // Content created 1 hour ago — should still accept comments
    const content = await seedContent(testDb, {
      created: Math.floor(Date.now() / 1000) - 3600,
    });
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Fresh comment',
      author: 'Eve',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('enforces commentsCheckReferer when enabled', async () => {
    await seedOptions(testDb, {
      commentsCheckReferer: '1',
      siteUrl: 'https://example.com',
    });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      { cid: String(content.cid), text: 'Spam from external', author: 'Spammer' },
      { referer: 'https://evil.com/page' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('marks comment as waiting when commentsRequireModeration is enabled', async () => {
    await seedOptions(testDb, { commentsRequireModeration: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Pending review',
      author: 'Frank',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const comment = await testDb.query.comments.findFirst();
    expect(comment?.status).toBe('waiting');
  });

  it('increments commentsNum on approved comment', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Counting!',
      author: 'Grace',
    });
    await POST({ request: req, locals: {} } as any);
    const updated = await testDb.query.contents.findFirst();
    expect(updated?.commentsNum).toBe(1);
  });

  it('does NOT increment commentsNum when comment is waiting', async () => {
    await seedOptions(testDb, { commentsRequireModeration: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Waiting...',
      author: 'Henry',
    });
    await POST({ request: req, locals: {} } as any);
    const updated = await testDb.query.contents.findFirst();
    expect(updated?.commentsNum).toBe(0);
  });

  // ── New validation tests (security fixes) ──

  it('returns 400 when comment text exceeds 10000 characters', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const longText = 'x'.repeat(10001);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: longText,
      author: 'Alice',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('过长');
  });

  it('accepts comment text at exactly 10000 characters', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb);
    const exactText = 'x'.repeat(10000);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: exactText,
      author: 'Alice',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('returns 400 when email format is invalid for anonymous user', async () => {
    await seedOptions(testDb, { commentsRequireMail: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Hello',
      author: 'Alice',
      mail: 'not-an-email',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('邮箱格式');
  });

  it('accepts valid email format for anonymous user', async () => {
    await seedOptions(testDb, { commentsRequireMail: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({
      cid: String(content.cid),
      text: 'Hello',
      author: 'Alice',
      mail: 'alice@example.com',
    });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('prevents open redirect in comment response', async () => {
    await seedOptions(testDb, { siteUrl: 'https://example.com' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      {
        cid: String(content.cid),
        text: 'Hello',
        author: 'Alice',
      },
      { referer: 'https://evil.com/phishing' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    // Should NOT redirect to evil.com
    expect(location).not.toContain('evil.com');
    // Should redirect to a safe path
    expect(location).toContain('#comments');
  });

  it('uses same-origin referer for redirect when valid', async () => {
    await seedOptions(testDb, { siteUrl: 'https://example.com' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest(
      {
        cid: String(content.cid),
        text: 'Hello',
        author: 'Alice',
      },
      { referer: 'https://example.com/archives/1/' },
    );
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    expect(location).toContain('/archives/1/');
    expect(location).toContain('#comments');
  });

  // NEW: Per-article rate limiting test
  it('allows same IP to comment on different articles (rate limit is per-article)', async () => {
    await seedOptions(testDb, {
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',  // 60 seconds
    });
    
    // Create two separate articles
    await testDb.insert(schema.contents).values({
      title: 'Post 1',
      slug: 'post-1',
      created: Math.floor(Date.now() / 1000) - 100,
      type: 'post',
      status: 'publish',
      allowComment: '1',
    });
    const post1 = await testDb.query.contents.findFirst({
      where: (contents, { eq }) => eq(contents.slug, 'post-1'),
    });

    await testDb.insert(schema.contents).values({
      title: 'Post 2',
      slug: 'post-2',
      created: Math.floor(Date.now() / 1000) - 100,
      type: 'post',
      status: 'publish',
      allowComment: '1',
    });
    const post2 = await testDb.query.contents.findFirst({
      where: (contents, { eq }) => eq(contents.slug, 'post-2'),
    });

    // Comment on Post 1 from IP 7.7.7.7
    const req1 = makeCommentRequest(
      { cid: String(post1!.cid), text: 'Comment on post 1', author: 'Test' },
      { 'cf-connecting-ip': '7.7.7.7' },
    );
    const res1 = await POST({ request: req1, locals: {} } as any);
    expect(res1.status).toBe(302);

    // Immediately comment on Post 2 from same IP (should succeed since it's a different article)
    const req2 = makeCommentRequest(
      { cid: String(post2!.cid), text: 'Comment on post 2', author: 'Test' },
      { 'cf-connecting-ip': '7.7.7.7' },
    );
    const res2 = await POST({ request: req2, locals: {} } as any);
    expect(res2.status).toBe(302);

    // But immediate follow-up comment on Post 1 should fail (rate limit)
    const req3 = makeCommentRequest(
      { cid: String(post1!.cid), text: 'Another comment on post 1', author: 'Test' },
      { 'cf-connecting-ip': '7.7.7.7' },
    );
    const res3 = await POST({ request: req3, locals: {} } as any);
    expect(res3.status).toBe(429);
  });

  it('rejects comment when commentsAntiSpam is enabled and token is missing', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Spam?', author: 'Bot' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comment when commentsAntiSpam is enabled and token is wrong', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Spam?', author: 'Bot', _: 'wrong-token' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('accepts comment when commentsAntiSpam is enabled and token is correct', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const requestUrl = 'https://example.com/';
    const token = await generateCommentToken('test-secret', requestUrl);
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Legit comment', author: 'Alice', _: token });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
  });

  it('rejects anti-spam token generated for API URL instead of referer page', async () => {
    await seedOptions(testDb, { commentsAntiSpam: '1' });
    const content = await seedContent(testDb);
    const token = await generateCommentToken('test-secret', 'https://example.com/api/comment');
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Wrong URL token', author: 'Alice', _: token });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comments on private content', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { status: 'private' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Nope', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comments on draft content', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { type: 'post_draft', status: 'draft' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Nope', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });

  it('rejects comments on attachments', async () => {
    await seedOptions(testDb);
    const content = await seedContent(testDb, { type: 'attachment', status: 'publish' });
    const req = makeCommentRequest({ cid: String(content.cid), text: 'Nope', author: 'Alice' });
    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(403);
  });
});
