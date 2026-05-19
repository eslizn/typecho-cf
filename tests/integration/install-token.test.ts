/**
 * G2-2 install token gating.
 *
 * Without INSTALL_TOKEN configured, the form falls back to legacy
 * "first caller wins" so existing deployments are not broken. With the
 * secret set, mismatch (or empty) tokens are rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;
let installToken: string | undefined;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  get env() {
    return {
      // ensureTables() expects a D1Database with batch/prepare; since the
      // tables already exist in testDb we no-op it.
      DB: {
        batch: async () => [],
        prepare: () => ({ first: async () => null }),
      },
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
  });

  it('allows install without token when INSTALL_TOKEN is unset (legacy)', async () => {
    installToken = undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await POST({
      request: buildRequest({
        siteTitle: 'My Site',
        userName: 'admin',
        userPassword: 'secret123',
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
        userPassword: 'secret123',
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
        userPassword: 'secret123',
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
        userPassword: 'secret123',
        userMail: 'admin@example.com',
      }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/login');
  });
});
