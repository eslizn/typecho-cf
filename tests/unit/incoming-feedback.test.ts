import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createTestDb, type TestDatabase } from '../helpers';
import { saveIncomingFeedback } from '@/lib/incoming-feedback';

const { filter, hook } = vi.hoisted(() => ({
  filter: vi.fn(async (_ctx: any, _point: string, value: any) => value),
  hook: vi.fn(async () => {}),
}));
const { verifySource } = vi.hoisted(() => ({ verifySource: vi.fn(async () => true) }));
vi.mock('@/lib/plugin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plugin')>('@/lib/plugin');
  return { ...actual, applyFilter: filter, doHook: hook };
});
// Outbound verification is mocked: these cases test the status decision, and
// the fetch path itself is covered by feedback-verification tests.
vi.mock('@/lib/feedback-verification', () => ({ verifyFeedbackSource: verifySource }));

let db: TestDatabase;
const ctx = { activatedPlugins: new Set<string>() } as any;
const options: any = { commentsRequireModeration: false };

async function seed() {
  const [row] = await db.insert(schema.contents).values({ title: 'Post', slug: 'post', type: 'post', status: 'publish', allowPing: '1', authorId: 7, commentsNum: 0 }).returning();
  return row;
}

describe('incoming trackback and pingback', () => {
  beforeEach(async () => {
    db = await createTestDb();
    filter.mockImplementation(async (_ctx: any, _point: string, value: any) => value);
    hook.mockClear();
    verifySource.mockReset();
    verifySource.mockResolvedValue(true);
  });

  it('stores an approved trackback and increments commentsNum', async () => {
    const post = await seed();
    const result = await saveIncomingFeedback(db as any, ctx, options, { cid: post.cid, author: 'Blog', url: 'https://source.test/a', text: 'Excerpt', type: 'trackback', ip: '1.1.1.1', agent: 'test' });
    expect(typeof result).toBe('number');
    const row = (await db.select().from(schema.comments))[0];
    expect(row).toMatchObject({ type: 'trackback', status: 'approved', ownerId: 7 });
    expect((await db.query.contents.findFirst())?.commentsNum).toBe(1);
  });

  it('moderates pingbacks and never counts waiting feedback', async () => {
    const post = await seed();
    const result = await saveIncomingFeedback(db as any, ctx, { ...options, commentsRequireModeration: true }, { cid: post.cid, author: 'Blog', url: 'https://source.test/a', text: 'Ping', type: 'pingback', ip: '1.1.1.1', agent: 'test' });
    expect(typeof result).toBe('number');
    expect((await db.select().from(schema.comments))[0].status).toBe('waiting');
    expect((await db.query.contents.findFirst())?.commentsNum).toBe(0);
  });

  it('rejects feedback whose source cannot be verified without writing a row', async () => {
    const post = await seed();
    verifySource.mockResolvedValueOnce(false);

    const result = await saveIncomingFeedback(db as any, ctx, options, { cid: post.cid, author: 'Spammer', url: 'https://unverified.test/x', text: 'Buy things', type: 'trackback', ip: '1.1.1.1', agent: 'test' });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(await db.select().from(schema.comments)).toHaveLength(0);
    expect((await db.query.contents.findFirst())?.commentsNum).toBe(0);
  });

  it('keeps verified feedback in the moderation queue when the switch is on', async () => {
    const post = await seed();
    verifySource.mockResolvedValueOnce(true);

    await saveIncomingFeedback(db as any, ctx, { ...options, commentsRequireModeration: true }, { cid: post.cid, author: 'Blog', url: 'https://source.test/b', text: 'Ping', type: 'pingback', ip: '1.1.1.1', agent: 'test' });

    expect((await db.select().from(schema.comments))[0].status).toBe('waiting');
  });

  it.each([
    ['missing content', 999, 'not-found'],
    ['ping disabled', 0, 'pinging-not-allowed'],
  ])('rejects %s', async (_name, cid, message) => {
    const post = await seed();
    if (cid === 0) await db.update(schema.contents).set({ allowPing: '0' }).where(eq(schema.contents.cid, post.cid));
    const result = await saveIncomingFeedback(db as any, ctx, options, { cid: cid || post.cid, author: 'Blog', url: 'https://source.test', text: 'x', type: 'pingback', ip: '', agent: '' });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).statusText || await (result as Response).text()).toContain(message);
  });

  it('allows filters to reject or transform incoming data', async () => {
    const post = await seed();
    filter.mockImplementationOnce(async (_ctx: any, _point: string, value: any) => ({ ...value, author: 'Filtered', status: 'waiting' }));
    await saveIncomingFeedback(db as any, ctx, options, { cid: post.cid, author: 'Blog', url: 'https://source.test', text: 'x', type: 'trackback', ip: '', agent: '' });
    expect((await db.select().from(schema.comments))[0]).toMatchObject({ author: 'Filtered', status: 'waiting' });
  });

  it('rejects the same source once per target and feedback type', async () => {
    const post = await seed();
    const input = { cid: post.cid, author: 'Blog', url: 'https://source.test/a', text: 'x', type: 'pingback' as const, ip: '', agent: '' };
    expect(await saveIncomingFeedback(db as any, ctx, options, input)).toEqual(expect.any(Number));
    const duplicate = await saveIncomingFeedback(db as any, ctx, options, input);
    expect(duplicate).toBeInstanceOf(Response);
    expect((duplicate as Response).status).toBe(409);
    expect(await db.select().from(schema.comments)).toHaveLength(1);
  });
});
