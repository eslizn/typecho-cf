import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { POST } from '@/pages/api/users/login';

describe('POST /api/users/login flash errors', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('redirects validation errors without exposing the message in the URL', async () => {
    const request = new Request('https://example.com/api/users/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }).toString(),
    });

    const response = await POST({ request, locals: {} } as any);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/login');
    expect(response.headers.get('Location')).not.toContain('error=');
    expect(response.headers.get('Set-Cookie')).toContain('__typecho_login_error=');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
  });
});
