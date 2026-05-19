/**
 * G8-3 regression: requireAdminCSRF should accept the CSRF token via
 * the X-CSRF-Token request header so that fetch()/JSON clients don't
 * have to clone/re-parse their body to embed the `_` field.
 */
import { describe, it, expect } from 'vitest';
import { requireAdminCSRF, generateSecurityToken } from '@/lib/auth';

const SECRET = 'csrf-header-secret';
const AUTH_CODE = 'header-auth-code';
const UID = 7;

async function buildToken(): Promise<string> {
  return generateSecurityToken(SECRET, AUTH_CODE, UID);
}

describe('extractAdminCSRFToken via X-CSRF-Token header (G8-3)', () => {
  it('accepts a valid token sent in the X-CSRF-Token header', async () => {
    const token = await buildToken();
    const request = new Request('https://example.com/api/admin/foo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
      },
      body: JSON.stringify({ payload: 'value' }),
    });
    const result = await requireAdminCSRF(request, SECRET, AUTH_CODE, UID);
    expect(result).toBeNull();
  });

  it('rejects when X-CSRF-Token header is malformed', async () => {
    const request = new Request('https://example.com/api/admin/foo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': 'this-is-not-a-real-token',
      },
      body: JSON.stringify({ payload: 'value' }),
    });
    const result = await requireAdminCSRF(request, SECRET, AUTH_CODE, UID);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it('still works with the legacy form-data `_` field', async () => {
    const token = await buildToken();
    const body = new URLSearchParams({ _: token });
    const request = new Request('https://example.com/api/admin/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await requireAdminCSRF(request, SECRET, AUTH_CODE, UID);
    expect(result).toBeNull();
  });

  it('still works with the legacy JSON body `_` field', async () => {
    const token = await buildToken();
    const request = new Request('https://example.com/api/admin/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _: token, payload: 'value' }),
    });
    const result = await requireAdminCSRF(request, SECRET, AUTH_CODE, UID);
    expect(result).toBeNull();
  });

  it('header takes priority over body when both provided', async () => {
    const token = await buildToken();
    // Body is junk; header is correct → must accept (header wins)
    const request = new Request('https://example.com/api/admin/foo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
      },
      body: JSON.stringify({ _: 'WRONG-BODY-TOKEN', payload: 'value' }),
    });
    const result = await requireAdminCSRF(request, SECRET, AUTH_CODE, UID);
    expect(result).toBeNull();
  });

  it('returns 403 when neither header nor body has a token', async () => {
    const request = new Request('https://example.com/api/admin/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'value' }),
    });
    const result = await requireAdminCSRF(request, SECRET, AUTH_CODE, UID);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
});
