import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin login flash messages', () => {
  it('reads login errors from flash cookies rather than URL query params', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/admin/login.astro'), 'utf8');

    expect(source).toContain('getFlashCookieValue');
    expect(source).toContain('clearFlashCookieHeader');
    expect(source).not.toContain("searchParams.get('error')");
    expect(source).not.toContain('searchParams.get("error")');
  });

  it('keeps login error redirects out of the Location query string', () => {
    const source = readFileSync(join(process.cwd(), 'src/pages/api/users/login.ts'), 'utf8');

    expect(source).toContain('redirectWithLoginError');
    expect(source).toContain('createFlashRedirectHeaders');
    expect(source).not.toContain('/admin/login?error=');
    expect(source).not.toContain('encodeURIComponent(');
  });
});
