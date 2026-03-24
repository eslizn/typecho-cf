/**
 * Generate CREATE TABLE / CREATE INDEX SQL statements from Drizzle schema at runtime.
 *
 * This eliminates the dependency on `drizzle/` migration files.
 * The single source of truth is `src/db/schema.ts`.
 */

import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable, SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as schema from '@/db/schema';

/* ---------- helpers ---------- */

function escName(name: string): string {
  return `\`${name}\``;
}

function isAutoIncrement(col: SQLiteColumn): boolean {
  // Drizzle stores autoincrement in the runtime config
  const cfg = (col as any).config;
  if (cfg?.autoIncrement) return true;
  // Also check the type config
  const meta = (col as any)._;
  if (meta?.isAutoincrement) return true;
  return false;
}

function buildCreateTable(table: SQLiteTable): string {
  const config = getTableConfig(table);
  const colDefs: string[] = [];

  for (const col of config.columns) {
    const parts: string[] = [escName(col.name), col.getSQLType()];

    if (col.primary) {
      parts.push('PRIMARY KEY');
      if (isAutoIncrement(col)) {
        parts.push('AUTOINCREMENT');
      }
    }

    if (col.notNull && !col.primary) {
      parts.push('NOT NULL');
    }

    if (col.hasDefault && col.default !== undefined) {
      const d = col.default;
      if (typeof d === 'string') {
        parts.push(`DEFAULT '${d}'`);
      } else if (typeof d === 'number') {
        parts.push(`DEFAULT ${d}`);
      }
    }

    colDefs.push(parts.join(' '));
  }

  return `CREATE TABLE IF NOT EXISTS ${escName(config.name)} (\n\t${colDefs.join(',\n\t')}\n)`;
}

function buildCreateIndexes(table: SQLiteTable): string[] {
  const config = getTableConfig(table);
  const stmts: string[] = [];

  for (const idx of config.indexes) {
    const cols = idx.config.columns
      .map((c) => {
        // IndexColumn can be SQLiteColumn or SQL
        if ('name' in c && typeof (c as any).name === 'string') {
          return escName((c as SQLiteColumn).name);
        }
        return String(c);
      })
      .join(', ');

    const keyword = idx.config.unique
      ? 'CREATE UNIQUE INDEX IF NOT EXISTS'
      : 'CREATE INDEX IF NOT EXISTS';

    stmts.push(`${keyword} ${escName(idx.config.name)} ON ${escName(config.name)} (${cols})`);
  }

  return stmts;
}

/* ---------- public API ---------- */

/**
 * All schema tables, in dependency-safe order (no FKs in this project, so order doesn't matter).
 */
const allTables: SQLiteTable[] = [
  schema.users,
  schema.contents,
  schema.comments,
  schema.metas,
  schema.relationships,
  schema.options,
  schema.fields,
];

/**
 * Generate all SQL statements needed to create the database from scratch.
 * Returns an array of individual SQL strings (one per CREATE TABLE / CREATE INDEX).
 */
export function generateCreateSQL(): string[] {
  const statements: string[] = [];
  for (const table of allTables) {
    statements.push(buildCreateTable(table));
    statements.push(...buildCreateIndexes(table));
  }
  return statements;
}
