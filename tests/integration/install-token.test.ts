/**
 * G2-2 install token gating.
 *
 * Without INSTALL_TOKEN configured, the form falls back to legacy
 * "first caller wins" so existing deployments are not broken. With the
 * secret set, mismatch (or empty) tokens are rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createD1TestDouble, createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;
let d1TestDouble: ReturnType<typeof createD1TestDouble>;
let installToken: string | undefined;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  get env() {
    return {
      DB: d1TestDouble,
      BUCKET: { delete: vi.fn() },
      INSTALL_TOKEN: installToken,
    };
  },
}));

import { POST } from '@/pages/api/install';

const SITE = 'https://example.com';

function buildRequest(body: Record<string, string>) {
  return new Request(`${SITE}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

describe('POST /api/install (G2-2)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    d1TestDouble = createD1TestDouble(testDb);
  });

  it('allows install without token when INSTALL_TOKEN is unset (legacy)', async () => {
    installToken = undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await POST({
      request: buildRequest({
        siteTitle: 'My Site',
        userName: 'admin',
        userPassword: 'strong-secret-123',
        userMail: 'admin@example.com',
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/login');
    // Warns operators that the install window is unprotected.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects install with wrong token when INSTALL_TOKEN is set', async () => {
    installToken = 'real-token';
    const response = await POST({
      request: buildRequest({
        installToken: 'wrong-token',
        siteTitle: 'My Site',
        userName: 'admin',
        userPassword: 'strong-secret-123',
        userMail: 'admin@example.com',
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
  });

  it('rejects install with missing token when INSTALL_TOKEN is set', async () => {
    installToken = 'real-token';
    const response = await POST({
      request: buildRequest({
        siteTitle: 'My Site',
        userName: 'admin',
        userPassword: 'strong-secret-123',
        userMail: 'admin@example.com',
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(403);
  });

  it('accepts install with correct token when INSTALL_TOKEN is set', async () => {
    installToken = 'real-token';
    const response = await POST({
      request: buildRequest({
        installToken: 'real-token',
        siteTitle: 'My Site',
        userName: 'admin',
        userPassword: 'strong-secret-123',
        userMail: 'admin@example.com',
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/login');
  });
});
