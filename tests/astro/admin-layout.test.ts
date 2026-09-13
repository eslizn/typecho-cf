/**
 * Render tests for the shared admin layout.
 *
 * Replaces the source greps in admin-accessibility.test.ts, the layout half of
 * admin-notice-dismissible.test.ts and the nav assertions in
 * admin-queues-page.test.ts: the layout is rendered and the HTML is asserted.
 */
import { describe, expect, it } from 'vitest';
import Admin from '@/layouts/Admin.astro';
import { createAdminErrorRedirect } from '@/lib/admin-flash';
import { renderComponent, testI18n } from './helpers';

const OPTIONS = {
  lang: 'en',
  charset: 'UTF-8',
  title: 'Test blog',
  description: 'A test blog',
  theme: 'typecho-theme-minimal',
  secret: 'test-secret',
} as any;

const URLS = {
  siteUrl: 'https://example.com',
  adminUrl: 'https://example.com/admin/',
  loginUrl: 'https://example.com/admin/login',
  logoutUrl: 'https://example.com/api/users/logout',
  profileUrl: 'https://example.com/admin/profile',
  feedUrl: 'https://example.com/feed',
  feedRssUrl: 'https://example.com/feed/rss',
  feedAtomUrl: 'https://example.com/feed/atom',
  commentsFeedUrl: 'https://example.com/feed/comments',
  commentsFeedRssUrl: 'https://example.com/feed/rss/comments',
  commentsFeedAtomUrl: 'https://example.com/feed/atom/comments',
  themeUrl: (file: string) => `https://example.com/themes/typecho-theme-minimal/${file}`,
} as any;

interface RenderAdminOptions {
  group?: string;
  activeMenu?: string;
  request?: Request;
}

function renderAdmin({ group = 'administrator', activeMenu = 'dashboard', request }: RenderAdminOptions = {}) {
  return renderComponent(Admin, {
    request: request || new Request('https://example.com/admin/'),
    props: {
      title: 'Overview',
      options: OPTIONS,
      urls: URLS,
      user: {
        uid: 7,
        group,
        name: 'admin',
        screenName: 'Admin',
        mail: 'admin@example.com',
        authCode: 'auth-code',
      } as any,
      activeMenu,
      i18n: testI18n('en'),
    },
    slots: { default: '<p id="page-content">page body</p>' },
  });
}

describe('Admin layout rendering', () => {
  it('keeps the viewport zoomable', async () => {
    const html = await renderAdmin();

    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
    expect(html).not.toContain('maximum-scale');
    expect(html).not.toContain('user-scalable');
  });

  it('renders the navigation toggle with its accessibility attributes', async () => {
    const html = await renderAdmin();

    expect(html).toContain('aria-controls="typecho-nav-list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<nav id="typecho-nav-list">');
  });

  it('ships the Escape and notice-dismiss handlers in its inline script', async () => {
    const html = await renderAdmin();

    expect(html).toContain("e.key === 'Escape'");
    expect(html).toContain("e.key === ' '");
    expect(html).toContain("trigger('focus')");
    expect(html).toContain("attr('aria-expanded', open ? 'true' : 'false')");
    expect(html).toContain("closest('.typecho-dismissible').remove()");
    expect(html).toContain("'.typecho-notice-close'");
    expect(html).toContain('ADMIN_SUCCESS_NOTICE_HIDE_DELAY_MS = 3000');
    expect(html).toContain("'.admin-notice--success.typecho-dismissible'");
    expect(html).toContain('new MutationObserver');
    expect(html).toContain("currentUrl.searchParams.delete('saved')");
    expect(html).toContain('window.history.replaceState');
  });

  it('does not lock the editor form after a new-tab preview submission', async () => {
    const html = await renderAdmin();

    expect(html).toContain("if (submitter && (submitter.formTarget === '_blank'");
    expect(html).toContain('document.activeElement.form === this');
    expect(html).toContain("$(submitter).attr('formtarget') === '_blank'");
  });

  it('marks the active menu entry', async () => {
    const html = await renderAdmin({ activeMenu: 'manage-queues' });

    expect(html).toContain('<li class="focus"><a href="/admin/manage-queues">');
  });

  it('only shows the queue page to administrators', async () => {
    const adminHtml = await renderAdmin({ group: 'administrator' });
    const contributorHtml = await renderAdmin({ group: 'contributor' });

    expect(adminHtml).toContain('href="/admin/manage-queues"');
    expect(contributorHtml).not.toContain('href="/admin/manage-queues"');
  });

  it('renders the page slot inside the layout', async () => {
    const html = await renderAdmin();

    expect(html).toContain('<p id="page-content">page body</p>');
  });

  it('places layout flash notices at the top of the page block', async () => {
    const flashResponse = await createAdminErrorRedirect(
      new Request('https://example.com/api/admin/content', {
        method: 'POST',
        headers: { referer: 'https://example.com/admin/write-post' },
      }),
      OPTIONS,
      7,
      'Save failed',
      '/admin/write-post',
    );
    const setCookie = flashResponse.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';', 1)[0];
    const html = await renderAdmin({
      request: new Request('https://example.com/admin/write-post', { headers: { cookie } }),
    });

    const pageMainIndex = html.indexOf('class="row typecho-page-main');
    const noticeIndex = html.indexOf('col-mb-12 admin-notice admin-notice--error');
    const slotIndex = html.indexOf('<p id="page-content">page body</p>');
    expect(pageMainIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeGreaterThan(pageMainIndex);
    expect(noticeIndex).toBeLessThan(slotIndex);
  });
});
