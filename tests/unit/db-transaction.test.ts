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

  it('does not pass async callbacks to better-sqlite3 synchronous transactions', async () => {
    const db = {
      constructor: { name: 'BetterSQLite3Database' },
      transaction: vi.fn(() => {
        throw new TypeError('Transaction function cannot return a promise');
      }),
    };

    const result = await withWriteTransaction(db, async (tx) => {
      expect(tx).toBe(db);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
