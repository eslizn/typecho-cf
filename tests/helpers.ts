import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { generateCreateSQL } from '@/lib/schema-sql';

/**
 * Create an in-memory SQLite database with all Typecho tables
 * generated from the canonical Drizzle schema definitions.
 */
export function createTestDb() {
  const sqlite = new Database(':memory:');
  for (const stmt of generateCreateSQL()) {
    sqlite.exec(stmt);
  }
  return drizzle(sqlite, { schema });
}
