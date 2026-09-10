import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resetIsolateBoot,
  ensureDatabaseReady,
  ensureTablesReady,
  ensurePasswordResetSchema,
  TablesMissingError,
} from '@/lib/isolate-boot';
import { isFtsAvailable, resetFtsAvailability } from '@/lib/fulltext';

// Mock generateIndexSQL so the test doesn't depend on actual schema
vi.mock('@/lib/schema-sql', () => ({
  generateIndexSQL: vi.fn(() => [
    'CREATE INDEX IF NOT EXISTS idx_test ON typecho_contents(slug)',
  ]),
}));

function mockD1(hasTable: boolean) {
  const first = vi.fn().mockResolvedValue(hasTable ? { name: 'typecho_options' } : null);
  return {
    prepare: vi.fn().mockReturnValue({ first, bind: vi.fn().mockReturnThis() }),
  } as unknown as D1Database;
}

beforeEach(() => {
  resetIsolateBoot();
  resetFtsAvailability();
});

describe('ensureTablesReady', () => {
  it('queries sqlite_master on first call', async () => {
    const d1 = mockD1(true);
    await ensureTablesReady(d1);
    expect(d1.prepare).toHaveBeenCalledTimes(1);
  });

  it('skips query on second call (cached)', async () => {
    const d1 = mockD1(true);
    await ensureTablesReady(d1);
    await ensureTablesReady(d1);
    expect(d1.prepare).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent checks into one D1 request', async () => {
    const d1 = mockD1(true);
    await Promise.all([ensureTablesReady(d1), ensureTablesReady(d1)]);
    expect(d1.prepare).toHaveBeenCalledTimes(1);
  });

  it('throws TablesMissingError when table absent', async () => {
    const d1 = mockD1(false);
    await expect(ensureTablesReady(d1)).rejects.toThrow(TablesMissingError);
  });

  it('throws generic Error when D1 query fails', async () => {
    const d1 = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockRejectedValue(new Error('D1 down')),
        bind: vi.fn().mockReturnThis(),
      }),
    } as unknown as D1Database;
    await expect(ensureTablesReady(d1)).rejects.toThrow('D1 down');
  });

  it('retries on next isolate after resetIsolateBoot', async () => {
    const d1a = mockD1(true);
    await ensureTablesReady(d1a);

    resetIsolateBoot();
    const d1b = mockD1(false);
    await expect(ensureTablesReady(d1b)).rejects.toThrow(TablesMissingError);
  });
});

describe('ensureDatabaseReady', () => {
  it('uses the persistent schema version fast path on a cold isolate', async () => {
    const first = vi.fn().mockResolvedValue({ value: '20260816' });
    const d1 = {
      prepare: vi.fn().mockReturnValue({ first }),
      batch: vi.fn(),
    } as unknown as D1Database;

    await ensureDatabaseReady(d1);

    expect(d1.prepare).toHaveBeenCalledOnce();
    expect(d1.batch).not.toHaveBeenCalled();
  });

  it('creates the login failure table when upgrading an older installation', async () => {
    const createRun = vi.fn().mockResolvedValue({});
    const markerRun = vi.fn().mockResolvedValue({});
    const indexRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("name='runtimeSchemaVersion'")) {
        return { first: vi.fn().mockResolvedValue({ value: null }) };
      }
      if (sql.startsWith('SELECT EXISTS')) {
        return { first: vi.fn().mockResolvedValue({ loginFailuresExists: 0 }) };
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS typecho_login_failures')) {
        return { run: createRun };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: markerRun })) };
      }
      if (sql.includes('sqlite_master') && sql.includes('typecho_metas_type_slug')) {
        return {
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({ sql: 'CREATE UNIQUE INDEX typecho_metas_type_slug ON typecho_metas (type, slug)' }),
          })),
        };
      }
      if (sql.startsWith('CREATE INDEX') || sql.startsWith('CREATE UNIQUE INDEX')) {
        return { run: indexRun };
      }
      return { sql, first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({}), bind: vi.fn().mockReturnThis() };
    });
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensureDatabaseReady(d1);

    expect(createRun).toHaveBeenCalledOnce();
    expect(prepare.mock.calls.some(([sql]) => String(sql).startsWith('CREATE TABLE IF NOT EXISTS typecho_login_failures'))).toBe(true);
  });

  it('coalesces concurrent cold-isolate initialization', async () => {
    let release!: (value: { user_version: number }) => void;
    const first = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const d1 = {
      prepare: vi.fn().mockReturnValue({ first }),
      batch: vi.fn(),
    } as unknown as D1Database;

    const a = ensureDatabaseReady(d1);
    const b = ensureDatabaseReady(d1);
    release({ value: '20260816' } as any);
    await Promise.all([a, b]);

    expect(d1.prepare).toHaveBeenCalledOnce();
  });

  it('upgrades a stale marker and persists the current schema version', async () => {
    const markerRun = vi.fn().mockResolvedValue({});
    const indexRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("name='runtimeSchemaVersion'")) {
        return { first: vi.fn().mockResolvedValue({ value: null }) };
      }
      if (sql.startsWith('SELECT EXISTS')) {
        return { first: vi.fn().mockResolvedValue({ loginFailuresExists: 1 }) };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: markerRun })) };
      }
      if (sql.includes('sqlite_master') && sql.includes('typecho_metas_type_slug')) {
        return {
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({ sql: 'CREATE UNIQUE INDEX typecho_metas_type_slug ON typecho_metas (type, slug)' }),
          })),
        };
      }
      if (sql.startsWith('CREATE INDEX') || sql.startsWith('CREATE UNIQUE INDEX')) {
        return { run: indexRun };
      }
      return { sql, first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({}), bind: vi.fn().mockReturnThis() };
    });
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensureDatabaseReady(d1);

    expect(indexRun).toHaveBeenCalled();
    expect(batch).toHaveBeenCalled();
    expect(markerRun).toHaveBeenCalledOnce();
  });

  it('does not persist the schema marker when metas unique index fails', async () => {
    const markerRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("name='runtimeSchemaVersion'")) {
        return { first: vi.fn().mockResolvedValue({ value: null }) };
      }
      if (sql.startsWith('SELECT EXISTS')) {
        return { first: vi.fn().mockResolvedValue({ loginFailuresExists: 1 }) };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: markerRun })) };
      }
      if (sql.includes('sqlite_master') && sql.includes('typecho_metas_type_slug')) {
        return {
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({ sql: 'CREATE INDEX typecho_metas_type_slug ON typecho_metas (type, slug)' }),
          })),
        };
      }
      return { sql, first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({}), bind: vi.fn().mockReturnThis() };
    });
    const batch = vi.fn().mockImplementation((stmts: unknown[]) => {
      // metas unique conversion batch fails (duplicates)
      if (Array.isArray(stmts) && stmts.length >= 3) {
        return Promise.reject(new Error('UNIQUE failed'));
      }
      return Promise.resolve([]);
    });
    const d1 = { prepare, batch } as unknown as D1Database;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureDatabaseReady(d1);

    expect(markerRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('defers index/FTS upgrade through waitUntil when available', async () => {
    const markerRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("name='runtimeSchemaVersion'")) {
        return { first: vi.fn().mockResolvedValue({ value: null }) };
      }
      if (sql.startsWith('SELECT EXISTS')) {
        return { first: vi.fn().mockResolvedValue({ loginFailuresExists: 1 }) };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: markerRun })) };
      }
      if (sql.includes('sqlite_master') && sql.includes('typecho_metas_type_slug')) {
        return {
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({ sql: 'CREATE UNIQUE INDEX typecho_metas_type_slug ON typecho_metas (type, slug)' }),
          })),
        };
      }
      return { sql, first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({}), bind: vi.fn().mockReturnThis() };
    });
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;
    let deferred: Promise<unknown> | undefined;
    const executionContext = {
      waitUntil: (p: Promise<unknown>) => { deferred = p; },
    };

    await ensureDatabaseReady(d1, executionContext);
    expect(markerRun).not.toHaveBeenCalled();
    expect(deferred).toBeDefined();
    await deferred;
    expect(markerRun).toHaveBeenCalledOnce();
  });

  it('does not persist the schema marker when FTS setup fails', async () => {
    const markerRun = vi.fn().mockResolvedValue({});
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("name='runtimeSchemaVersion'")) {
        return { first: vi.fn().mockResolvedValue({ value: null }) };
      }
      if (sql.startsWith('SELECT EXISTS')) {
        return { first: vi.fn().mockResolvedValue({ loginFailuresExists: 1 }) };
      }
      if (sql.includes("name IN ('typecho_password_reset_requests'")) {
        return { all: vi.fn().mockResolvedValue({ results: [{ name: 'typecho_password_reset_requests' }] }) };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return { all: vi.fn().mockResolvedValue({
          results: ['email', 'lastSentAt', 'uid', 'tokenHash', 'expiresAt'].map(name => ({ name })),
        }) };
      }
      if (sql.startsWith('INSERT INTO typecho_options')) {
        return { bind: vi.fn(() => ({ run: markerRun })) };
      }
      if (sql.includes('sqlite_master') && sql.includes('typecho_metas_type_slug')) {
        return {
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({ sql: 'CREATE UNIQUE INDEX typecho_metas_type_slug ON typecho_metas (type, slug)' }),
          })),
        };
      }
      return { sql, first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({}), bind: vi.fn().mockReturnThis() };
    });
    const batch = vi.fn((stmts: Array<{ sql?: string }>) => {
      if (stmts.some(stmt => String(stmt.sql || '').includes('typecho_contents_fts'))) {
        return Promise.reject(new Error('FTS down'));
      }
      return Promise.resolve([]);
    });
    const d1 = { prepare, batch } as unknown as D1Database;

    await expect(ensureDatabaseReady(d1)).resolves.toBeUndefined();

    expect(markerRun).not.toHaveBeenCalled();
    expect(isFtsAvailable()).toBe(false);
  });
});

describe('ensurePasswordResetSchema', () => {
  it('renames the legacy throttle table and adds reset-token columns', async () => {
    const prepare = vi.fn((sql: string) => ({
      sql,
      all: vi.fn().mockResolvedValue(
        sql.includes('sqlite_master')
          ? { results: [{ name: 'typecho_password_reset_throttle' }] }
          : { results: [{ name: 'email' }, { name: 'lastSentAt' }] },
      ),
    }));
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensurePasswordResetSchema(d1);

    expect(batch).toHaveBeenCalledTimes(2);
    const rename = batch.mock.calls[0][0] as Array<{ sql: string }>;
    expect(rename[0].sql).toBe(
      'ALTER TABLE typecho_password_reset_throttle RENAME TO typecho_password_reset_requests',
    );
    expect(rename[1].sql).toBe('DROP INDEX IF EXISTS typecho_password_reset_tokenHash');
    const upgrades = batch.mock.calls[1][0] as Array<{ sql: string }>;
    expect(upgrades.map(statement => statement.sql)).toEqual([
      'ALTER TABLE typecho_password_reset_requests ADD COLUMN uid INTEGER',
      'ALTER TABLE typecho_password_reset_requests ADD COLUMN tokenHash TEXT',
      'ALTER TABLE typecho_password_reset_requests ADD COLUMN expiresAt INTEGER',
    ]);
  });

  it('runs only once after a successful upgrade', async () => {
    const prepare = vi.fn((sql: string) => ({
      sql,
      all: vi.fn().mockResolvedValue(
        sql.includes('sqlite_master')
          ? { results: [{ name: 'typecho_password_reset_requests' }] }
          : {
              results: [
                { name: 'email' },
                { name: 'lastSentAt' },
                { name: 'uid' },
                { name: 'tokenHash' },
                { name: 'expiresAt' },
              ],
            },
      ),
    }));
    const batch = vi.fn().mockResolvedValue([]);
    const d1 = { prepare, batch } as unknown as D1Database;

    await ensurePasswordResetSchema(d1);
    await ensurePasswordResetSchema(d1);

    expect(batch).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
