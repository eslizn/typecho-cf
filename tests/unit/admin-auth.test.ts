import { describe, it, expect, vi } from 'vitest';
import { safeAdminRedirectUrl } from '@/lib/admin-auth';

describe('safeAdminRedirectUrl', () => {
  const siteUrl = 'https://example.com';

  it('returns referer path when it matches siteUrl host', () => {
    const result = safeAdminRedirectUrl(
      'https://example.com/admin/manage-comments?status=spam',
      siteUrl,
      '/admin/manage-comments',
    );
    expect(result).toBe('/admin/manage-comments?status=spam');
  });

  it('rejects cross-origin referer and returns fallback', () => {
    const result = safeAdminRedirectUrl(
      'https://evil.com/admin/manage-comments',
      siteUrl,
      '/admin/manage-comments',
    );
    expect(result).toBe('/admin/manage-comments');
  });

  it('rejects same-host referer with a different protocol', () => {
    const result = safeAdminRedirectUrl(
      'http://example.com/admin/manage-comments',
      siteUrl,
      '/admin/manage-comments',
    );
    expect(result).toBe('/admin/manage-comments');
  });

  it('rejects same-origin referer outside the admin area', () => {
    const result = safeAdminRedirectUrl(
      'https://example.com/',
      siteUrl,
      '/admin/',
    );
    expect(result).toBe('/admin/');
  });

  it('allows the admin root path', () => {
    const result = safeAdminRedirectUrl(
      'https://example.com/admin',
      siteUrl,
      '/admin/',
    );
    expect(result).toBe('/admin');
  });

  it('rejects referer with javascript: scheme and returns fallback', () => {
    const result = safeAdminRedirectUrl(
      'javascript:alert(1)',
      siteUrl,
      '/admin/manage-comments',
    );
    expect(result).toBe('/admin/manage-comments');
  });

  it('returns fallback when referer is null', () => {
    const result = safeAdminRedirectUrl(null, siteUrl, '/admin/options-general');
    expect(result).toBe('/admin/options-general');
  });

  it('returns fallback when referer is empty string', () => {
    const result = safeAdminRedirectUrl('', siteUrl, '/admin/manage-posts');
    expect(result).toBe('/admin/manage-posts');
  });

  it('handles referer with hash fragment', () => {
    const result = safeAdminRedirectUrl(
      'https://example.com/admin/manage-comments#section',
      siteUrl,
      '/admin/manage-comments',
    );
    expect(result).toBe('/admin/manage-comments');
  });

  it('handles subdomain mismatch', () => {
    const result = safeAdminRedirectUrl(
      'https://sub.example.com/admin/path',
      siteUrl,
      '/fallback',
    );
    expect(result).toBe('/fallback');
  });

  it('preserves query parameters from same-origin referer', () => {
    const result = safeAdminRedirectUrl(
      'https://example.com/admin/manage-posts?page=2&type=post',
      siteUrl,
      '/admin/manage-posts',
    );
    expect(result).toBe('/admin/manage-posts?page=2&type=post');
  });

  it('falls back when same-origin referer has no admin path', () => {
    const result = safeAdminRedirectUrl(
      'https://example.com',
      siteUrl,
      '/admin/',
    );
    expect(result).toBe('/admin/');
  });
});
