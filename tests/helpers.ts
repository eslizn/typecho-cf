import { createClient } from '@libsql/client/node';
import { drizzle } from 'drizzle-orm/libsql/node';
import * as schema from '@/db/schema';
import { generateCreateSQL } from '@/lib/schema-sql';
import { hashPassword, generateAuthToken } from '@/lib/auth';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

const dbPaths = new WeakMap<object, string>();

/**
 * Create an ephemeral file-based SQLite database with all Typecho tables
 * generated from the canonical Drizzle schema definitions.
 *
 * Uses a temp file instead of :memory: because @libsql/client's transaction()
 * invalidates the internal DB handle (sets #db = null), and for :memory:
 * databases the lazily-created replacement connection would point to a
 * brand-new empty database, losing all previously created tables.
 */
export async function createTestDb() {
  const dbPath = join(tmpdir(), `typecho-test-${randomUUID()}.db`);
  const client = createClient({ url: `file:${dbPath}` });
  for (const stmt of generateCreateSQL()) {
    await client.execute(stmt);
  }
  const db = drizzle({ client, schema });
  dbPaths.set(db, dbPath);
  return db;
}

/**
 * Close the database and delete the backing temp file.
 * Call in afterAll / afterEach to avoid accumulation in CI or watch mode.
 */
export async function disposeTestDb(db: Awaited<ReturnType<typeof createTestDb>>) {
  const dbPath = dbPaths.get(db);
  if (dbPath) {
    try { unlinkSync(dbPath); } catch { /* already removed */ }
    dbPaths.delete(db);
  }
}

// ---- shared seed helpers ----------------------------------------------------

export interface SeedAdminOptions {
  secret: string;
  authCode: string;
  group?: string;
}

/**
 * Seed admin user and secret option. Returns the created user row.
 */
export async function seedAdmin(
  db: TestDatabase,
  { secret, authCode, group = 'administrator' }: SeedAdminOptions,
) {
  await db.insert(schema.options).values({ name: 'secret', user: 0, value: secret });
  await db.insert(schema.users).values({
    name: 'admin',
    password: await hashPassword('admin123'),
    mail: 'admin@example.com',
    group,
    authCode,
  });
  return (await db.query.users.findFirst())!;
}

/**
 * Generate the auth cookie header for a seeded user.
 */
export async function makeAuthCookie(
  db: TestDatabase,
  uid: number,
  authCode: string,
  secret: string,
) {
  const token = await generateAuthToken(uid, authCode, secret);
  const [uidPart, hash] = token.split(':');
  return `__typecho_uid=${uidPart}; __typecho_authCode=${hash}`;
}

export type TestDatabase = Awaited<ReturnType<typeof createTestDb>>;
