import { describe, expect, it, vi } from 'vitest';
import { withWriteTransaction } from '@/lib/db-transaction';

describe('withWriteTransaction()', () => {
  it('uses async-capable transaction implementations when available', async () => {
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<string>) => {
        return await callback({ tx: true });
      }),
    };

    const result = await withWriteTransaction(db, async (tx) => {
      expect(tx).toEqual({ tx: true });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('runs the callback directly when no transaction implementation is available', async () => {
    const db = {
      query: true,
    };

    const result = await withWriteTransaction(db, async (tx) => {
      expect(tx).toBe(db);
      return 'ok';
    });

    expect(result).toBe('ok');
  });
});
