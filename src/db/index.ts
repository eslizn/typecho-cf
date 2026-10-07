import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getDb(d1: D1Database) {
  // D1 read replicas are only considered when queries run through the
  // Sessions API. A bookmark represents one logical consistency sequence,
  // so each request bootstrap gets a fresh Session; Request Core is
  // responsible for reusing this Drizzle handle inside that request.
  const queryable = typeof d1.withSession === 'function'
    ? d1.withSession('first-unconstrained')
    : d1;
  return drizzle(queryable as D1Database, { schema });
}

/** Use the current D1 primary when revocation state must be observed immediately. */
export function getPrimaryDb(d1: D1Database) {
  const primary = typeof d1.withSession === 'function'
    ? d1.withSession('first-primary')
    : d1;
  return drizzle(primary as D1Database, { schema });
}

export type Database = ReturnType<typeof getDb>;

export { schema };
