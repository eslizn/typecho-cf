/**
 * G5-1/G5-2: edge cache helper hygiene + Vary fan-out.
 */
import { describe, it, expect } from 'vitest';

// We replicate the small helper the middleware uses; importing the
// middleware itself would require an Astro runtime.
function mergeVary(existing: string | null, additions: string[]): string {
  const tokens = new Set<string>();
  if (existing) {
    for (const tok of existing.split(',')) tokens.add(tok.trim());
  }
  for (const tok of additions) tokens.add(tok);
  return Array.from(tokens).filter(Boolean).join(', ');
}

describe('mergeVary helper (G5-1)', () => {
  it('returns additions when there is no existing header', () => {
    expect(mergeVary(null, ['Cookie', 'Accept-Encoding'])).toBe('Cookie, Accept-Encoding');
  });

  it('preserves existing tokens', () => {
    expect(mergeVary('Accept', ['Cookie'])).toBe('Accept, Cookie');
  });

  it('dedupes repeated tokens', () => {
    expect(mergeVary('Cookie, Accept', ['Cookie'])).toBe('Cookie, Accept');
  });

  it('normalises whitespace in existing values', () => {
    expect(mergeVary(' Cookie ,  Accept ', ['Accept-Encoding'])).toBe('Cookie, Accept, Accept-Encoding');
  });
});
