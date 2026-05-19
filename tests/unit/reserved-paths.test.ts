/**
 * G6-4 reserved-path tests (we re-implement the predicate here since
 * importing the middleware requires Astro runtime).
 */
import { describe, it, expect } from 'vitest';

function isReservedCorePath(path: string): boolean {
  if (path === '/install' || path === '/api/install') return true;
  if (path === '/admin' || path.startsWith('/admin/')) return true;
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return true;
  if (path === '/api/users/login' || path === '/api/users/logout' || path === '/api/users/register') return true;
  return false;
}

describe('reserved core paths (G6-4)', () => {
  it.each([
    '/install',
    '/api/install',
    '/admin',
    '/admin/',
    '/admin/manage-posts',
    '/api/admin',
    '/api/admin/options',
    '/api/users/login',
    '/api/users/logout',
    '/api/users/register',
  ])('%s is reserved', (p) => {
    expect(isReservedCorePath(p)).toBe(true);
  });

  it.each([
    '/',
    '/post/1',
    '/api/comment',
    '/dav',
    '/admins',          // not /admin/
    '/api/admin-extra', // not /api/admin/
    '/api/users/me',    // not auth endpoint
  ])('%s is plugin-claimable', (p) => {
    expect(isReservedCorePath(p)).toBe(false);
  });
});
