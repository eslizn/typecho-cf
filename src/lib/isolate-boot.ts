/**
 * Per-isolate boot state for Cloudflare Workers.
 *
 * Workers reuse the same isolate across many requests. Certain one-time
 * checks (table existence, index creation) only need to run once per
 * isolate lifetime. This module aggregates those checks so middleware
 * doesn't carry module-level mutable booleans.
 *
 * All state is intentionally per-isolate (module-scope). Pending promises
 * coalesce requests that interleave while the first async check is running.
 */

import { generateIndexSQL } from '@/lib/schema-sql';
import { CONTENTS_FTS_TABLE, contentsFtsSql, ftsRebuildStatement, setFtsAvailable } from '@/lib/fulltext';

/** Thrown when D1 has no typecho_options table — legitimate install-redirect case. */
export class TablesMissingError extends Error {
  constructor() {
    super('tables-missing');
    this.name = 'TablesMissingError';
  }
}

interface IsolateBoot {
  databaseReadyPassed: boolean;
  tableCheckPassed: boolean;
  passwordResetSchemaPassed: boolean;
  indexEnsurePassed: boolean;
  databaseReadyPending?: Promise<void>;
  tableCheckPending?: Promise<void>;
  passwordResetSchemaPending?: Promise<void>;
  indexEnsurePending?: Promise<boolean>;
}

const state: IsolateBoot = {
  databaseReadyPassed: false,
  tableCheckPassed: false,
  passwordResetSchemaPassed: false,
  indexEnsurePassed: false,
};

/**
 * Resets all boot state. Exposed for tests so individual test cases
 * can simulate a cold isolate without forking a new worker process.
 */
export function resetIsolateBoot(): void {
  state.databaseReadyPassed = false;
  state.tableCheckPassed = false;
  state.passwordResetSchemaPassed = false;
  state.indexEnsurePassed = false;
  state.databaseReadyPending = undefined;
  state.tableCheckPending = undefined;
  state.passwordResetSchemaPending = undefined;
  state.indexEnsurePending = undefined;
}

// Reserved by Typecho-CF's runtime schema bootstrap. Bump this whenever the
// runtime password-reset upgrade or generated index set changes. A stable
// database needs one indexed point lookup per cold isolate instead of probing
// every table, column and index.
const RUNTIME_SCHEMA_VERSION = '20260816';
const RUNTIME_SCHEMA_VERSION_KEY = 'runtimeSchemaVersion';
const METAS_TYPE_SLUG_INDEX = 'typecho_metas_type_slug';
const OPTIONS_USER_NAME_INDEX = 'typecho_options_user_name';
const OPTIONS_NAME_USER_INDEX_LEGACY = 'typecho_options_name_user';

export async function ensureDatabaseReady(
  d1: D1Database,
  executionContext?: Pick<ExecutionContext, 'waitUntil'> | null,
): Promise<void> {
  if (state.databaseReadyPassed) return;
  if (state.databaseReadyPending) return state.databaseReadyPending;

  const pending = (async () => {
    let schemaVersion: string | null;
    try {
      schemaVersion = await d1
        .prepare(
          "SELECT value FROM typecho_options " +
          "WHERE name='runtimeSchemaVersion' AND user=0 LIMIT 1",
        )
        .first<{ value: string | null }>()
        .then(row => row?.value ?? null);
    } catch (error) {
      if (error instanceof Error && /no such table:\s*typecho_options/i.test(error.message)) {
        throw new TablesMissingError();
      }
      throw error;
    }
    state.tableCheckPassed = true;

    // Fast path: the marker is only persisted after the login-failure table,
    // password-reset schema, indexes and FTS are all ready, so a matching
    // version means the runtime schema is complete. Skip sqlite_master probes
    // entirely on stable databases.
    if (schemaVersion === RUNTIME_SCHEMA_VERSION) {
      state.passwordResetSchemaPassed = true;
      state.indexEnsurePassed = true;
      // The marker is only persisted once indexes *and* FTS were ready, so a
      // matching version is proof that MATCH is safe on this isolate.
      setFtsAvailable(true);
      state.databaseReadyPassed = true;
      return;
    }

    // Older installations may predate the persistent login throttle table.
    // Create it before the upgrade so login never fails with SQLITE_ERROR.
    const marker = await d1
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' " +
        "AND name='typecho_login_failures') AS loginFailuresExists",
      )
      .first<{ loginFailuresExists?: boolean | number }>();
    if (marker?.loginFailuresExists === false || marker?.loginFailuresExists === 0) {
      await d1.prepare(
        'CREATE TABLE IF NOT EXISTS typecho_login_failures (' +
        'ip TEXT PRIMARY KEY NOT NULL, ' +
        'failures INTEGER NOT NULL DEFAULT 0, ' +
        'windowStartedAt INTEGER NOT NULL DEFAULT 0, ' +
        'bannedUntil INTEGER NOT NULL DEFAULT 0)',
      ).run();
    }
    // Password-reset schema is request-critical (login/reset paths). Index and
    // FTS rebuilds can be large — defer them off the hot path when possible.
    await ensurePasswordResetSchema(d1);
    state.databaseReadyPassed = true;

    const finishUpgrade = async () => {
      const indexesOk = await ensureIndexesReady(d1);
      // Persist the marker only after required indexes AND FTS are ready.
      // A failed unique-index conversion must not permanently skip retries.
      const ftsReady = await ensureFtsReady(d1);
      if (indexesOk && ftsReady) {
        await d1.prepare(
          'INSERT INTO typecho_options (name, user, value) VALUES (?, ?, ?) ' +
          'ON CONFLICT(user, name) DO UPDATE SET value=excluded.value',
        ).bind(RUNTIME_SCHEMA_VERSION_KEY, 0, RUNTIME_SCHEMA_VERSION).run();
      }
    };

    if (executionContext?.waitUntil) {
      executionContext.waitUntil(
        finishUpgrade().catch(err => console.warn('[isolate-boot] deferred schema upgrade failed:', err)),
      );
    } else {
      await finishUpgrade();
    }
  })();
  state.databaseReadyPending = pending;
  try {
    await pending;
  } finally {
    if (state.databaseReadyPending === pending) state.databaseReadyPending = undefined;
  }
}

/**
 * Creates the FTS5 search index (external-content table + sync triggers)
 * and rebuilds it when the table did not exist. Runs once per schema
 * version bump. Returns false (and marks FTS unavailable) on failure so
 * the search path falls back to a LIKE scan; boot itself never fails.
 */
async function ensureFtsReady(d1: D1Database): Promise<boolean> {
  try {
    const existing = await d1
      // Constant table name — no user input, so string interpolation is safe
      // here and keeps the query compatible with the test D1 mock (no bind()).
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${CONTENTS_FTS_TABLE}'`)
      .first<{ name: string }>();
    const statements = contentsFtsSql();
    if (!existing) statements.push(ftsRebuildStatement());

    const stmts: D1PreparedStatement[] = [];
    for (const statement of statements) {
      stmts.push(d1.prepare(statement));
    }
    await d1.batch(stmts);
    setFtsAvailable(true);
    return true;
  } catch (error) {
    console.warn(
      '[isolate-boot] FTS5 setup failed, search falls back to LIKE:',
      error instanceof Error ? error.message : String(error),
    );
    setFtsAvailable(false);
    return false;
  }
}

/**
 * Ensures the D1 database has the typecho_options table.
 *
 * On the first request after a cold start, queries sqlite_master.
 * If the table exists, sets tableCheckPassed=true so subsequent
 * requests skip this check.
 *
 * Throws 'tables-missing' if the table does not exist, letting the
 * caller redirect to /install.
 */
export async function ensureTablesReady(d1: D1Database): Promise<void> {
  if (state.tableCheckPassed) return;
  if (state.tableCheckPending) return state.tableCheckPending;
  const pending = (async () => {
    const row = await d1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='typecho_options'")
      .first<{ name: string }>();
    if (!row) throw new TablesMissingError();
    state.tableCheckPassed = true;
  })();
  state.tableCheckPending = pending;
  try {
    await pending;
  } finally {
    if (state.tableCheckPending === pending) state.tableCheckPending = undefined;
  }
}

const PASSWORD_RESET_COLUMNS = [
  ['uid', 'INTEGER'],
  ['tokenHash', 'TEXT'],
  ['expiresAt', 'INTEGER'],
] as const;

/**
 * Ensures the password-reset request table exists and is current.
 *
 * The earlier implementation called this table
 * `typecho_password_reset_throttle`. Rename that table in place so existing
 * rate-limit and pending-token state survives the terminology correction.
 */
export async function ensurePasswordResetSchema(d1: D1Database): Promise<void> {
  if (state.passwordResetSchemaPassed) return;
  if (state.passwordResetSchemaPending) return state.passwordResetSchemaPending;
  const pending = (async () => {
    const tables = await d1.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' " +
      "AND name IN ('typecho_password_reset_requests', 'typecho_password_reset_throttle')",
    ).all<{ name: string }>();
    const tableNames = new Set((tables.results ?? []).map(table => table.name));
    const hasCurrent = tableNames.has('typecho_password_reset_requests');
    const hasLegacy = tableNames.has('typecho_password_reset_throttle');

    if (hasLegacy && !hasCurrent) {
      await d1.batch([
        d1.prepare(
          'ALTER TABLE typecho_password_reset_throttle ' +
          'RENAME TO typecho_password_reset_requests',
        ),
        d1.prepare('DROP INDEX IF EXISTS typecho_password_reset_tokenHash'),
      ]);
    } else if (!hasCurrent) {
      await d1.batch([
        d1.prepare(
          'CREATE TABLE typecho_password_reset_requests (' +
          'email TEXT PRIMARY KEY NOT NULL, ' +
          'lastSentAt INTEGER NOT NULL DEFAULT 0, ' +
          'uid INTEGER, tokenHash TEXT, expiresAt INTEGER)',
        ),
      ]);
    }

    const result = await d1
      .prepare("PRAGMA table_info('typecho_password_reset_requests')")
      .all<{ name: string }>();
    const existing = new Set((result.results ?? []).map(column => column.name));
    const upgrades: D1PreparedStatement[] = [];
    for (const [name, type] of PASSWORD_RESET_COLUMNS) {
      if (!existing.has(name)) {
        upgrades.push(
          d1.prepare(`ALTER TABLE typecho_password_reset_requests ADD COLUMN ${name} ${type}`),
        );
      }
    }
    if (upgrades.length > 0) await d1.batch(upgrades);
    state.passwordResetSchemaPassed = true;
  })();
  state.passwordResetSchemaPending = pending;
  try {
    await pending;
  } finally {
    if (state.passwordResetSchemaPending === pending) state.passwordResetSchemaPending = undefined;
  }
}

async function ensureIndexesReady(d1: D1Database): Promise<boolean> {
  if (state.indexEnsurePassed) return true;
  if (state.indexEnsurePending) return state.indexEnsurePending;
  const indexStatements = generateIndexSQL();
  const pending = (async () => {
    let allOk = true;

    // Convert metas (type, slug) to UNIQUE: drop legacy non-unique index of the
    // same name, dedupe rows, then create the unique index. Failure must not
    // be swallowed into a successful schema marker.
    if (!(await ensureMetasTypeSlugUnique(d1))) {
      allOk = false;
    }

    // Reorder options unique index to (user, name) so WHERE user = ? can use
    // the leftmost prefix. Drop the legacy (name, user) index of the old name.
    if (!(await ensureOptionsUserNameUnique(d1))) {
      allOk = false;
    }

    for (const sql of indexStatements) {
      if (sql.includes(METAS_TYPE_SLUG_INDEX)) continue;
      if (sql.includes(OPTIONS_USER_NAME_INDEX)) continue;
      try {
        await d1.prepare(sql).run();
      } catch (error) {
        allOk = false;
        console.warn(
          '[isolate-boot] index backfill skipped:',
          sql,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    state.indexEnsurePassed = allOk;
    return allOk;
  })();
  state.indexEnsurePending = pending;
  try {
    return await pending;
  } finally {
    if (state.indexEnsurePending === pending) state.indexEnsurePending = undefined;
  }
}

/**
 * Ensure typecho_options has UNIQUE (user, name).
 * Legacy installs used UNIQUE (name, user) under typecho_options_name_user —
 * that index cannot serve the loadOptions hot path `WHERE user = ?`.
 */
async function ensureOptionsUserNameUnique(d1: D1Database): Promise<boolean> {
  try {
    const existing = await d1.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    ).bind(OPTIONS_USER_NAME_INDEX).first<{ sql: string | null }>();

    const sql = existing?.sql ?? '';
    const hasCorrect =
      /\bUNIQUE\b/i.test(sql) &&
      /\(\s*`?user`?\s*,\s*`?name`?\s*\)/i.test(sql);

    if (hasCorrect) {
      // Clean up the legacy name if a previous upgrade left both indexes.
      await d1.prepare(`DROP INDEX IF EXISTS ${OPTIONS_NAME_USER_INDEX_LEGACY}`).run();
      return true;
    }

    await d1.batch([
      d1.prepare(`DROP INDEX IF EXISTS ${OPTIONS_NAME_USER_INDEX_LEGACY}`),
      d1.prepare(`DROP INDEX IF EXISTS ${OPTIONS_USER_NAME_INDEX}`),
      d1.prepare(
        `CREATE UNIQUE INDEX ${OPTIONS_USER_NAME_INDEX} ON typecho_options (user, name)`,
      ),
    ]);
    return true;
  } catch (error) {
    console.warn(
      '[isolate-boot] options (user, name) unique index failed:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Ensure typecho_metas has a UNIQUE (type, slug) index.
 * Legacy installs may still have a non-unique index of the same name and/or
 * duplicate rows — both must be repaired before CREATE UNIQUE INDEX.
 */
async function ensureMetasTypeSlugUnique(d1: D1Database): Promise<boolean> {
  try {
    const existing = await d1.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    ).bind(METAS_TYPE_SLUG_INDEX).first<{ sql: string | null }>();

    if (existing?.sql && /\bUNIQUE\b/i.test(existing.sql)) {
      return true;
    }

    // Remap relationships from duplicate metas onto the keeper (MIN mid),
    // collapse duplicate (cid, mid) pairs, then drop duplicate meta rows.
    await d1.batch([
      d1.prepare(
        'UPDATE typecho_relationships SET mid = (' +
        'SELECT MIN(keeper.mid) FROM typecho_metas AS keeper ' +
        'INNER JOIN typecho_metas AS loser ON loser.mid = typecho_relationships.mid ' +
        'WHERE keeper.type = loser.type ' +
        "AND IFNULL(keeper.slug, '') = IFNULL(loser.slug, '')" +
        ') WHERE mid IN (' +
        'SELECT loser.mid FROM typecho_metas AS loser ' +
        'WHERE EXISTS (' +
        'SELECT 1 FROM typecho_metas AS keeper ' +
        'WHERE keeper.type = loser.type ' +
        "AND IFNULL(keeper.slug, '') = IFNULL(loser.slug, '') " +
        'AND keeper.mid < loser.mid))',
      ),
      d1.prepare(
        'DELETE FROM typecho_relationships WHERE rowid NOT IN (' +
        'SELECT MIN(rowid) FROM typecho_relationships GROUP BY cid, mid)',
      ),
      d1.prepare(
        'DELETE FROM typecho_metas WHERE mid NOT IN (' +
        "SELECT MIN(mid) FROM typecho_metas GROUP BY type, IFNULL(slug, ''))",
      ),
      d1.prepare(`DROP INDEX IF EXISTS ${METAS_TYPE_SLUG_INDEX}`),
      d1.prepare(
        `CREATE UNIQUE INDEX ${METAS_TYPE_SLUG_INDEX} ON typecho_metas (type, slug)`,
      ),
    ]);
    return true;
  } catch (error) {
    console.warn(
      '[isolate-boot] metas (type, slug) unique index failed:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
