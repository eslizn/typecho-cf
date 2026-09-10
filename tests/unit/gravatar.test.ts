import { describe, expect, it } from 'vitest';
import { buildGravatarUrl, createGravatarHash, md5Hex } from '@/lib/gravatar';

describe('gravatar helpers', () => {
  it('hashes trimmed lowercase email addresses with MD5', async () => {
    await expect(createGravatarHash(' MyEmailAddress@example.com ')).resolves.toBe(
      // Official gravatar.com example hash for this address.
      '0bc83cb571cd1c50ba6f3e8a78ef1346',
    );
  });

  it('matches the RFC 1321 reference digests, including multi-byte UTF-8', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '9e107d9d372bb6826bd81d3542a419d6',
    );
    expect(md5Hex('中文邮箱@example.com')).toBe('eca8dd5735c551c1fa036de46efde79f');
  });

  it('builds avatar URLs with the email hash in the path', async () => {
    const url = await buildGravatarUrl(' MyEmailAddress@example.com ', {
      defaultImage: 'identicon',
      size: 40,
      rating: 'G',
    });

    expect(url).toBe(
      'https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?d=identicon&s=40&r=G',
    );
  });

  it('keeps the default avatar URL valid when no email exists', async () => {
    await expect(buildGravatarUrl('', { defaultImage: 'mp', size: 220 })).resolves.toBe(
      'https://www.gravatar.com/avatar/?d=mp&s=220',
    );
  });
});
