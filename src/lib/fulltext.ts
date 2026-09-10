/**
 * FTS5 full-text search over typecho_contents (title + text).
 *
 * The index is an external-content FTS5 virtual table kept in sync by
 * triggers on typecho_contents, so search never scans the body text column.
 * The table is runtime-managed (see schema-sql.ts / isolate-boot.ts) and is
 * intentionally NOT part of the Drizzle schema — it is a derived index, not
 * a Typecho-compatible table.
 *
 * The trigram tokenizer gives substring semantics for CJK and Latin alike,
 * but only for queries of >= FTS_MIN_CHARS characters; shorter keywords fall
 * back to the capped LIKE path in page-data.ts.
 */
import { sql } from 'drizzle-orm';

export const CONTENTS_FTS_TABLE = 'typecho_contents_fts';

/** Keywords shorter than this cannot use the trigram tokenizer. */
export const FTS_MIN_CHARS = 3;

/**
 * Per-isolate FTS availability, flipped by isolate-boot's ensureFtsReady().
 *
 * 'unknown' means the bootstrap has not confirmed the virtual table yet and is
 * treated as *unavailable*. isolate-boot defers index/FTS creation to
 * waitUntil() while upgrading a legacy database, so a request routed inside
 * that window would otherwise run MATCH against a table that does not exist
 * yet. Falling back to LIKE is correct in every 'unknown' case.
 */
type FtsAvailability = 'unknown' | 'ready' | 'failed';
let ftsAvailability: FtsAvailability = 'unknown';

export function setFtsAvailable(available: boolean): void {
  ftsAvailability = available ? 'ready' : 'failed';
}

/** Test-only: reset availability to the pre-boot state. */
export function resetFtsAvailability(): void {
  ftsAvailability = 'unknown';
}

/** True only when the FTS5 index is known to exist; otherwise search falls back to LIKE. */
export function isFtsAvailable(): boolean {
  return ftsAvailability === 'ready';
}

/** Raw SQL reference (backtick-quoted) for use in Drizzle join/where clauses. */
export const contentsFtsTableRef = sql.raw(`\`${CONTENTS_FTS_TABLE}\``);

/** DDL for the FTS index: virtual table + sync triggers. Idempotent. */
export function contentsFtsSql(): string[] {
  const t = CONTENTS_FTS_TABLE;
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS \`${t}\` USING fts5(` +
      `title, text, content='typecho_contents', content_rowid='cid', tokenize='trigram')`,
    `CREATE TRIGGER IF NOT EXISTS typecho_contents_fts_ai AFTER INSERT ON typecho_contents BEGIN ` +
      `INSERT INTO \`${t}\`(rowid, title, text) VALUES (new.cid, new.title, new.text); END`,
    `CREATE TRIGGER IF NOT EXISTS typecho_contents_fts_ad AFTER DELETE ON typecho_contents BEGIN ` +
      `INSERT INTO \`${t}\`(\`${t}\`, rowid, title, text) VALUES ('delete', old.cid, old.title, old.text); END`,
    `CREATE TRIGGER IF NOT EXISTS typecho_contents_fts_au AFTER UPDATE ON typecho_contents BEGIN ` +
      `INSERT INTO \`${t}\`(\`${t}\`, rowid, title, text) VALUES ('delete', old.cid, old.title, old.text); ` +
      `INSERT INTO \`${t}\`(rowid, title, text) VALUES (new.cid, new.title, new.text); END`,
  ];
}

/** Rebuild the index from typecho_contents (external-content tables only). */
export function ftsRebuildStatement(): string {
  return `INSERT INTO \`${CONTENTS_FTS_TABLE}\`(\`${CONTENTS_FTS_TABLE}\`) VALUES ('rebuild')`;
}

/**
 * Build an FTS5 MATCH expression from a user keyword: each whitespace
 * separated term becomes a double-quoted phrase (AND semantics). Embedded
 * double quotes are doubled per FTS5 escaping rules.
 */
export function buildFtsMatchExpression(keywords: string): string {
  return keywords
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ');
}
