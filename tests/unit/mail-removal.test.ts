import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf8');
}

describe('core mail removal', () => {
  it('does not expose the removed mail settings', () => {
    const generalPage = readProjectFile('src/pages/admin/options-general.astro');
    const discussionPage = readProjectFile('src/pages/admin/options-discussion.astro');

    expect(generalPage).not.toMatch(/mailEnabled|mailFrom|mailFromName/);
    expect(discussionPage).not.toMatch(/commentEmailEnabled|commentEmailReplyEnabled/);
  });

  it('does not expose core mail delivery or forgot-password entry points', () => {
    expect(readProjectFile('src/lib/plugin.ts')).not.toContain("'mail:send'");
    expect(readProjectFile('src/pages/admin/login.astro')).not.toContain('/admin/forgot-password');
    expect(existsSync(join(projectRoot, 'src/lib/mail.ts'))).toBe(false);
    expect(existsSync(join(projectRoot, 'src/lib/comment-email.ts'))).toBe(false);
    expect(existsSync(join(projectRoot, 'src/pages/admin/forgot-password.astro'))).toBe(false);
    expect(existsSync(join(projectRoot, 'src/pages/api/users/forgot-password.ts'))).toBe(false);
  });
});
