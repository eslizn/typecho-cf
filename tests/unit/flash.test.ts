import { describe, expect, it } from 'vitest';
import {
  clearFlashCookieHeader,
  createFlashCookieHeader,
  createFlashRedirectHeaders,
  getFlashCookieValue,
} from '@/lib/flash';

describe('flash cookie helpers', () => {
  it('stores non-ASCII messages in an HttpOnly short-lived cookie', () => {
    const header = createFlashCookieHeader('__flash', '请输入用户名', { path: '/admin/login' });

    expect(header).toContain('__flash=%E8%AF%B7%E8%BE%93%E5%85%A5%E7%94%A8%E6%88%B7%E5%90%8D');
    expect(header).toContain('Path=/admin/login');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=60');
  });

  it('reads encoded flash messages from Cookie headers', () => {
    const message = getFlashCookieValue(
      'theme=dark; __flash=%E8%AF%B7%E5%AE%8C%E6%88%90%E4%BA%BA%E6%9C%BA%E9%AA%8C%E8%AF%81',
      '__flash',
    );

    expect(message).toBe('请完成人机验证');
  });

  it('returns a clearing cookie with matching path', () => {
    const header = clearFlashCookieHeader('__flash', { path: '/admin/login' });

    expect(header).toContain('__flash=;');
    expect(header).toContain('Path=/admin/login');
    expect(header).toContain('Max-Age=0');
  });

  it('creates redirect headers without putting the message in Location', () => {
    const headers = createFlashRedirectHeaders('/admin/login', '__flash', '用户名或密码无效', '/admin/login');

    expect(headers.get('Location')).toBe('/admin/login');
    expect(headers.get('Location')).not.toContain('error=');
    expect(headers.get('Set-Cookie')).toContain('__flash=');
  });
});
