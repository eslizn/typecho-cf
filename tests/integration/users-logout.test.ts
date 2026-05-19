/**
 * Integration test for /api/users/logout (G1-1).
 *
 * GET must NOT clear cookies — that closes the CSRF logout vector via
 * <img src=...>. Only POST is allowed to mutate session state.
 */
import { describe, expect, it } from 'vitest';
import { GET, POST } from '@/pages/api/users/logout';

describe('users/logout endpoint (G1-1)', () => {
  it('GET redirects without clearing cookies', async () => {
    const response = await GET({
      request: new Request('https://example.com/api/users/logout'),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    // Critical: no cookie mutation on GET (CSRF defence).
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('POST clears auth cookies', async () => {
    const response = await POST({
      request: new Request('https://example.com/api/users/logout', { method: 'POST' }),
      locals: {},
    } as any);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    const setCookie = response.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('__typecho_uid=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('POST omits Secure for plain http (dev mode)', async () => {
    const response = await POST({
      request: new Request('http://localhost:4321/api/users/logout', { method: 'POST' }),
      locals: {},
    } as any);
    expect(response.headers.get('Set-Cookie') || '').not.toContain('Secure');
  });

  it('POST emits Secure for https', async () => {
    const response = await POST({
      request: new Request('https://example.com/api/users/logout', { method: 'POST' }),
      locals: {},
    } as any);
    expect(response.headers.get('Set-Cookie') || '').toContain('Secure');
  });
});
