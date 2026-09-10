/**
 * Content-management permission rules.
 *
 * Typecho parity: an editor manages every post/page, a contributor only their
 * own, and an administrator everything.
 */
import { describe, expect, it } from 'vitest';
import { canManageResource } from '@/lib/auth';

describe('canManageResource', () => {
  const contributor = { uid: 7, group: 'contributor' };

  it('keeps a contributor inside their own content', () => {
    expect(canManageResource(contributor, { authorId: 7 })).toBe(true);
    expect(canManageResource(contributor, { authorId: 8 })).toBe(false);
  });

  it('lets an editor manage content authored by someone else', () => {
    expect(canManageResource({ uid: 3, group: 'editor' }, { authorId: 8 })).toBe(true);
  });

  it('lets an administrator manage any content', () => {
    expect(canManageResource({ uid: 1, group: 'administrator' }, { authorId: 8 })).toBe(true);
  });

  it('falls back to the ownerId snapshot when authorId is missing', () => {
    expect(canManageResource(contributor, { ownerId: 7 })).toBe(true);
    expect(canManageResource(contributor, { ownerId: 8 })).toBe(false);
  });

  it('never grants a subscriber management rights over foreign content', () => {
    expect(canManageResource({ uid: 9, group: 'subscriber' }, { authorId: 8 })).toBe(false);
    expect(canManageResource({ uid: 9, group: 'subscriber' }, { authorId: 9 })).toBe(true);
  });
});
