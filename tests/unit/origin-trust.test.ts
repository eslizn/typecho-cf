/**
 * Negative regression tests for the origin/referer trust boundary.
 *
 * Both safeAdminRedirectUrl and isSameOriginRequest must compare by
 * URL.origin only — host/prefix matches are not enough (AGENTS.md §8.3).
 */
import { describe, it, expect } from 'vitest';
import { isSameOriginRequest, safeAdminRedirectUrl } from '@/lib/admin-auth';

describe('safeAdminRedirectUrl()', () => {
  const SITE = 'https://blog.example.com';
  const FALLBACK = '/admin/';

  it('accepts /admin and /admin/* paths on the same origin', () => {
    expect(safeAdminRedirectUrl(`${SITE}/admin`, SITE, FALLBACK)).toBe('/admin');
    expect(safeAdminRedirectUrl(`${SITE}/admin/manage-posts`, SITE, FALLBACK)).toBe('/admin/manage-posts');
    expect(safeAdminRedirectUrl(`${SITE}/admin/?page=2`, SITE, FALLBACK)).toBe('/admin/?page=2');
  });

  it('rejects non-/admin paths even on the same origin', () => {
    expect(safeAdminRedirectUrl(`${SITE}/`, SITE, FALLBACK)).toBe(FALLBACK);
    expect(safeAdminRedirectUrl(`${SITE}/post/1/`, SITE, FALLBACK)).toBe(FALLBACK);
    expect(safeAdminRedirectUrl(`${SITE}/admins`, SITE, FALLBACK)).toBe(FALLBACK);
  });

  it('rejects cross-origin URLs even when path is /admin/...', () => {
    expect(safeAdminRedirectUrl('https://evil.com/admin/', SITE, FALLBACK)).toBe(FALLBACK);
    expect(safeAdminRedirectUrl('https://evil.com/admin/manage-posts', SITE, FALLBACK)).toBe(FALLBACK);
  });

  it('rejects protocol-mismatch even with the same host', () => {
    expect(safeAdminRedirectUrl('http://blog.example.com/admin/', SITE, FALLBACK)).toBe(FALLBACK);
  });

  it('rejects host-prefix forgery (evil.com.example.com → evil.com)', () => {
    expect(safeAdminRedirectUrl('https://blog.example.com.evil.com/admin/', SITE, FALLBACK)).toBe(FALLBACK);
  });

  it('rejects malformed URLs', () => {
    expect(safeAdminRedirectUrl('not a url', SITE, FALLBACK)).toBe(FALLBACK);
    expect(safeAdminRedirectUrl('//evil.com/admin/', SITE, FALLBACK)).toBe(FALLBACK);
  });

  it('returns the fallback when referer is null/empty', () => {
    expect(safeAdminRedirectUrl(null, SITE, FALLBACK)).toBe(FALLBACK);
    expect(safeAdminRedirectUrl('', SITE, FALLBACK)).toBe(FALLBACK);
  });
});

describe('isSameOriginRequest()', () => {
  const SITE = 'https://blog.example.com';

  function req(headers: Record<string, string>): Request {
    return new Request(`${SITE}/api/admin/test`, { method: 'POST', headers });
  }

  it('returns true when Origin matches', () => {
    expect(isSameOriginRequest(req({ origin: SITE }), SITE)).toBe(true);
  });

  it('returns false on cross-origin Origin', () => {
    expect(isSameOriginRequest(req({ origin: 'https://evil.com' }), SITE)).toBe(false);
  });

  it('returns false on protocol mismatch', () => {
    expect(isSameOriginRequest(req({ origin: 'http://blog.example.com' }), SITE)).toBe(false);
  });

  it('falls back to Referer when Origin is missing', () => {
    expect(isSameOriginRequest(req({ referer: `${SITE}/admin/manage-posts` }), SITE)).toBe(true);
  });

  it('returns false when Referer is cross-origin', () => {
    expect(isSameOriginRequest(req({ referer: 'https://evil.com/admin/' }), SITE)).toBe(false);
  });

  it('returns false when both Origin and Referer are missing', () => {
    expect(isSameOriginRequest(req({}), SITE)).toBe(false);
  });

  it('rejects host-prefix forgery on Origin (evil-host containing legit prefix)', () => {
    expect(isSameOriginRequest(req({ origin: 'https://blog.example.com.evil.com' }), SITE)).toBe(false);
  });

  it('falls back to permissive when siteUrl is unconfigured', () => {
    // Empty siteUrl signals fresh-install / test fixtures.
    expect(isSameOriginRequest(req({}), '')).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'https://anywhere.example' }), '')).toBe(true);
  });
});
