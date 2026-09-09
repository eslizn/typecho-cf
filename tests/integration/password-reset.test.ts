import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import * as schema from '@/db/schema';
import {
  generateResetToken,
  hashResetToken,
  hashPassword,
  parseResetToken,
  verifyPassword,
} from '@/lib/auth';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});
import { POST as resetPassword } from '@/pages/api/users/reset-password';

async function seedUser() {
  await testDb.insert(schema.options).values([
    { name: 'siteUrl', user: 0, value: 'https://example.com' },
    { name: 'title', user: 0, value: 'Test Blog' },
  ]);
  await testDb.insert(schema.users).values({
    name: 'alice',
    mail: 'alice@example.com',
    password: await hashPassword('old-password'),
    authCode: 'existing-session-code',
    group: 'subscriber',
  });
  return (await testDb.query.users.findFirst())!;
}

function formRequest(path: string, fields: Record<string, string>) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://example.com',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields),
  });
}

describe('password reset flow', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('parses a valid pending token and rejects it after expiry', async () => {
    const user = await seedUser();
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.passwordResetRequests).values({
      email: user.mail!,
      lastSentAt: now,
      uid: user.uid,
      tokenHash,
      expiresAt: now + 60,
    });

    expect(await parseResetToken(token, testDb as any, now)).toMatchObject({ valid: true, uid: user.uid });
    expect(await parseResetToken(token, testDb as any, now + 61)).toMatchObject({ valid: false, error: 'expired' });
  });

  it('consumes the token once and invalidates sessions only after reset succeeds', async () => {
    const user = await seedUser();
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.passwordResetRequests).values({
      email: user.mail!,
      lastSentAt: now,
      uid: user.uid,
      tokenHash,
      expiresAt: now + 3600,
    });

    const first = await resetPassword({
      request: formRequest('/api/users/reset-password', { token, password: 'new-password', confirm: 'new-password' }),
    } as any);
    expect(first.status).toBe(302);

    const updated = await testDb.query.users.findFirst();
    expect(updated?.authCode).not.toBe('existing-session-code');
    expect(await verifyPassword('new-password', updated?.password || '')).toBe(true);
    expect((await testDb.query.passwordResetRequests.findFirst())?.tokenHash).toBeNull();

    const second = await resetPassword({
      request: formRequest('/api/users/reset-password', { token, password: 'another-password', confirm: 'another-password' }),
    } as any);
    expect(second.status).toBe(400);
    expect(await verifyPassword('new-password', (await testDb.query.users.findFirst())?.password || '')).toBe(true);
  });

  it('rejects a confirmation mismatch without consuming the reset token', async () => {
    const user = await seedUser();
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token);
    const now = Math.floor(Date.now() / 1000);
    await testDb.insert(schema.passwordResetRequests).values({
      email: user.mail!,
      lastSentAt: now,
      uid: user.uid,
      tokenHash,
      expiresAt: now + 3600,
    });

    const response = await resetPassword({
      request: formRequest('/api/users/reset-password', {
        token,
        password: 'new-password',
        confirm: 'different-password',
      }),
    } as any);
    expect(response.status).toBe(400);
    expect((await testDb.query.passwordResetRequests.findFirst())?.tokenHash).toBe(tokenHash);
    expect((await testDb.query.users.findFirst())?.authCode).toBe('existing-session-code');
  });
});
