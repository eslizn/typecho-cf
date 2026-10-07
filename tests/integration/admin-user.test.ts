import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;
let actorUid: number;
vi.mock('@/lib/admin-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-auth')>('@/lib/admin-auth');
  return { ...actual, requireAdminAction: async () => ({ db: testDb, uid: actorUid }) };
});
import { POST } from '@/pages/api/admin/user';

beforeEach(async () => {
  testDb = await createTestDb();
  const [actor] = await testDb.insert(schema.users).values({
    name: 'actor', mail: 'actor@example.com', group: 'administrator',
  }).returning();
  actorUid = actor.uid;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeTestDb(testDb);
});

function request(uid: number, group: string) {
  return new Request('https://example.com/api/admin/user', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ do: 'update', uid: String(uid), mail: `${uid}@example.com`, group }),
  });
}

describe('administrator demotion', () => {
  it('rejects demoting the last administrator', async () => {
    const response = await POST({ request: request(actorUid, 'subscriber'), locals: {} } as any);
    expect(response.status).toBe(400);
    expect((await testDb.query.users.findFirst())?.group).toBe('administrator');
  });

  it('checks administrator count at the update boundary after a concurrent demotion', async () => {
    const [target] = await testDb.insert(schema.users).values({
      name: 'target', mail: 'target@example.com', group: 'administrator',
    }).returning();
    const batch = testDb.batch.bind(testDb);
    vi.spyOn(testDb, 'batch').mockImplementationOnce(async (statements: any) => {
      const snapshot = await batch(statements);
      await testDb.update(schema.users).set({ group: 'editor' }).where(eq(schema.users.uid, actorUid));
      return snapshot as any;
    });
    const response = await POST({ request: request(target.uid, 'subscriber'), locals: {} } as any);
    expect(response.status).toBe(400);
    expect((await testDb.query.users.findFirst({ where: eq(schema.users.uid, target.uid) }))?.group)
      .toBe('administrator');
  });

  it('allows demotion when another administrator remains', async () => {
    await testDb.insert(schema.users).values({ name: 'other', mail: 'other@example.com', group: 'administrator' });
    const response = await POST({ request: request(actorUid, 'subscriber'), locals: {} } as any);
    expect(response.status).toBe(302);
  });
});
