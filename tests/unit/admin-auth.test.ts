import { describe, it, expect, vi } from 'vitest';
import { canUseContentEditor, jsonAdminActionError, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { setRequestCoreContext } from '@/lib/context';
import { createI18n } from '@/lib/i18n';
import { coreCatalogs } from '@/i18n/catalogs';

function attachCoreI18n(request: Request) {
  const i18n = createI18n({ locale: 'zh-CN', catalogs: coreCatalogs });
  setRequestCoreContext({} as App.Locals, {
    db: {} as any,
    options: {} as any,
    pluginCtx: { activatedPlugins: new Set<string>() },
    i18n,
    resolvedLocale: { locale: 'zh-CN', bundleName: 'zh-CN@test', source: 'fixed' },
    autoLocale: false,
  }, request);
}

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

describe('jsonAdminActionError', () => {
  it('preserves descriptor status and message for JSON clients', async () => {
    const request = new Request('https://example.com/api/admin/action');
    attachCoreI18n(request);
    const response = new Response('请求体过大', {
      status: 413,
      headers: { 'X-Typecho-I18n-Code': 'core.error.requestBodyTooLarge' },
    });

    const result = jsonAdminActionError(request, response);
    expect(result.status).toBe(413);
    expect(await result.json()).toEqual({ error: '请求体过大', code: 'core.error.requestBodyTooLarge' });
  });

  it('does not rewrite unrelated response statuses as forbidden', () => {
    const request = new Request('https://example.com/api/admin/action');
    const response = new Response('service unavailable', { status: 503 });
    expect(jsonAdminActionError(request, response)).toBe(response);
  });
});

describe('canUseContentEditor', () => {
  const contributor = { uid: 7, group: 'contributor' };

  it('rejects subscribers, visitors, and unknown groups outright', () => {
    // Regression: /admin/write-post used to check only requireAuth, so any
    // signed-in account (registration creates subscribers) could read any
    // post's body and password via ?cid=N.
    expect(canUseContentEditor({ uid: 9, group: 'subscriber' }, null)).toBe(false);
    expect(canUseContentEditor({ uid: 9, group: 'visitor' }, null)).toBe(false);
    expect(canUseContentEditor({ uid: 9, group: null }, null)).toBe(false);
  });

  it('lets a contributor open their own content', () => {
    expect(canUseContentEditor(contributor, { authorId: 7 })).toBe(true);
    expect(canUseContentEditor(contributor, { ownerId: 7 })).toBe(true);
  });

  it("rejects a contributor opening another author's content", () => {
    expect(canUseContentEditor(contributor, { authorId: 8 })).toBe(false);
  });

  it("allows an administrator to open another author's content", () => {
    expect(canUseContentEditor({ uid: 1, group: 'administrator' }, { authorId: 8 })).toBe(true);
  });

  it("allows an editor to open another author's content (Typecho parity)", () => {
    expect(canUseContentEditor({ uid: 3, group: 'editor' }, { authorId: 8 })).toBe(true);
  });

  it('honours a stricter minimum group', () => {
    expect(canUseContentEditor(contributor, null, 'editor')).toBe(false);
    expect(canUseContentEditor({ uid: 3, group: 'editor' }, null, 'editor')).toBe(true);
  });
});
