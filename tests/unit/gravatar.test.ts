import { describe, expect, it } from 'vitest';
import { buildGravatarUrl, createGravatarHash } from '@/lib/gravatar';

describe('gravatar helpers', () => {
  it('hashes trimmed lowercase email addresses with SHA-256', async () => {
    await expect(createGravatarHash(' MyEmailAddress@example.com ')).resolves.toBe(
      '84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee',
    );
  });

  it('builds avatar URLs with the email hash in the path', async () => {
    const url = await buildGravatarUrl(' MyEmailAddress@example.com ', {
      defaultImage: 'identicon',
      size: 40,
      rating: 'G',
    });

    expect(url).toBe(
      'https://www.gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?d=identicon&s=40&r=G',
    );
  });

  it('keeps the default avatar URL valid when no email exists', async () => {
    await expect(buildGravatarUrl('', { defaultImage: 'mp', size: 220 })).resolves.toBe(
      'https://www.gravatar.com/avatar/?d=mp&s=220',
    );
  });
});
