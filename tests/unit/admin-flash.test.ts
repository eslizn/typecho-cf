import { describe, expect, it } from 'vitest';
import {
  adminFallbackForApiPath,
  clearAdminFlash,
  createAdminErrorRedirect,
  isAdminHtmlFormRequest,
  readAdminFlash,
} from '@/lib/admin-flash';
import { createI18n } from '@/lib/i18n';

const options = { secret: 'flash-secret', siteUrl: 'https://example.com' } as any;

describe('admin form flash errors', () => {
  it('redirects native form errors to a safe same-origin admin referer', async () => {
    const request = new Request('https://example.com/api/admin/user', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://example.com/admin/user?uid=4',
      },
    });
    const response = await createAdminErrorRedirect(request, options, 7, '邮箱已被使用', '/admin/manage-users');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/user?uid=4');
    expect(response.headers.get('set-cookie')).toContain('__typecho_admin_flash=');

    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    const nextRequest = new Request('https://example.com/admin/user?uid=4', { headers: { cookie } });
    expect(await readAdminFlash(nextRequest, options, 7)).toBe('邮箱已被使用');
    expect(await readAdminFlash(nextRequest, options, 8)).toBeNull();
  });

  it('rejects tampered or expired-looking flash values', async () => {
    const request = new Request('https://example.com/admin');
    const response = await createAdminErrorRedirect(request, options, 7, '失败', '/admin');
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    const tampered = `${cookie.slice(0, -1)}x`;
    expect(await readAdminFlash(new Request('https://example.com/admin', { headers: { cookie: tampered } }), options, 7)).toBeNull();
  });

  it('keeps JSON and AJAX requests out of the HTML redirect path', () => {
    const base = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } } as RequestInit;
    expect(isAdminHtmlFormRequest(new Request('https://example.com/api/admin/user', base))).toBe(true);
    expect(isAdminHtmlFormRequest(new Request('https://example.com/api/admin/user', {
      ...base, headers: { ...base.headers as Record<string, string>, accept: 'application/json' },
    }))).toBe(false);
    expect(isAdminHtmlFormRequest(new Request('https://example.com/api/admin/user', {
      ...base, headers: { ...base.headers as Record<string, string>, 'x-requested-with': 'XMLHttpRequest' },
    }))).toBe(false);
  });

  it('maps endpoint families to safe fallback pages', () => {
    expect(adminFallbackForApiPath('/api/admin/theme-config')).toBe('/admin/themes');
    expect(adminFallbackForApiPath('/api/admin/content')).toBe('/admin/manage-posts');
    expect(adminFallbackForApiPath('/api/admin/unknown')).toBe('/admin');
    expect(clearAdminFlash(new Request('https://example.com/admin'))).toContain('Max-Age=0');
  });

  it('preserves a bounded descriptor and resolves it with the display locale', async () => {
    const request = new Request('https://example.com/api/admin/user', {
      method: 'POST',
      headers: { referer: 'https://example.com/admin/user' },
    });
    const response = await createAdminErrorRedirect(request, options, 7, {
      key: 'admin.error.greeting',
      variables: { name: 'Alice' },
      fallbackText: 'Hello, {name}',
    }, '/admin');
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    const nextRequest = new Request('https://example.com/admin/user', { headers: { cookie } });
    const i18n = createI18n({ locale: 'en', catalogs: { en: { 'admin.error.greeting': 'Welcome, {name}' } } });

    expect(await readAdminFlash(nextRequest, options, 7, i18n)).toBe('Welcome, Alice');
    expect(await readAdminFlash(nextRequest, options, 7)).toBe('Hello, Alice');
  });
});
