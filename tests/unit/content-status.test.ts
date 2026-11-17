import { describe, expect, it } from 'vitest';
import { resolveContentWritePolicy } from '@/lib/content-status';

const base = {
  kind: 'post' as const,
  isEditor: true,
  isDraft: false,
  visibility: 'publish',
  password: null as string | null,
};

describe('resolveContentWritePolicy', () => {
  it('forces contributors to the review queue and clears passwords', () => {
    expect(resolveContentWritePolicy({ ...base, isEditor: false, visibility: 'publish', password: 'secret' }))
      .toEqual({ status: 'waiting', password: null });
    expect(resolveContentWritePolicy({ ...base, isEditor: false, isDraft: true, visibility: 'hidden', password: 'secret' }))
      .toEqual({ status: 'waiting', password: null });
  });

  it('honours editor visibility choices and clears non-password secrets', () => {
    expect(resolveContentWritePolicy({ ...base, visibility: 'hidden', password: 'secret' }))
      .toEqual({ status: 'hidden', password: null });
    expect(resolveContentWritePolicy({ ...base, visibility: 'private', password: 'secret' }))
      .toEqual({ status: 'private', password: null });
    expect(resolveContentWritePolicy({ ...base, visibility: 'waiting', password: 'secret' }))
      .toEqual({ status: 'waiting', password: null });
  });

  it('keeps the password only for the password visibility', () => {
    expect(resolveContentWritePolicy({ ...base, visibility: 'password', password: 'secret' }))
      .toEqual({ status: 'publish', password: 'secret' });
    expect(resolveContentWritePolicy({ ...base, visibility: 'unknown', password: 'secret' }))
      .toEqual({ status: 'publish', password: null });
  });

  it('keeps editor drafts in the draft workflow', () => {
    expect(resolveContentWritePolicy({ ...base, isDraft: true, visibility: 'publish', password: 'secret' }))
      .toEqual({ status: 'draft', password: 'secret' });
  });

  it('maps pages to publish/hidden and preserves their password', () => {
    expect(resolveContentWritePolicy({ ...base, kind: 'page', visibility: 'hidden', password: 'secret' }))
      .toEqual({ status: 'hidden', password: 'secret' });
    expect(resolveContentWritePolicy({ ...base, kind: 'page', visibility: 'publish', password: null }))
      .toEqual({ status: 'publish', password: null });
  });
});
