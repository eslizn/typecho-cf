export async function withWriteTransaction<TDb, TResult>(
  db: TDb,
  fn: (tx: TDb) => Promise<TResult>,
): Promise<TResult> {
  const transaction = (db as { transaction?: unknown }).transaction;
  if (typeof transaction === 'function' && !hasSynchronousTransaction(db)) {
    return await (transaction as (callback: (tx: TDb) => Promise<TResult>) => Promise<TResult>)
      .call(db, fn);
  }

  return await fn(db);
}

function hasSynchronousTransaction(db: unknown): boolean {
  const candidate = db as {
    constructor?: { name?: string };
    session?: {
      constructor?: { name?: string };
      client?: { constructor?: { name?: string } };
    };
    $client?: { constructor?: { name?: string } };
  };

  return candidate.constructor?.name === 'BetterSQLite3Database'
    || candidate.session?.constructor?.name === 'BetterSQLiteSession'
    || candidate.session?.client?.constructor?.name === 'Database'
    || candidate.$client?.constructor?.name === 'Database';
}
