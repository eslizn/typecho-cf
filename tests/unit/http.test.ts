import { describe, expect, it } from 'vitest';
import { jsonError } from '@/lib/http';

describe('jsonError()', () => {
  it('keeps error as a string when a descriptor fails validation', async () => {
    const response = jsonError(400, {
      key: 'core.error.badRequest',
      variables: { value: 'x'.repeat(2_001) },
    });
    const body = await response.json() as { error: unknown; code?: unknown };

    expect(body.error).toBe('Invalid request');
    expect(typeof body.error).toBe('string');
    expect(body.code).toBeUndefined();
  });
});
