export async function withWriteTransaction<TDb, TResult>(
  db: TDb,
  fn: (tx: TDb) => Promise<TResult>,
): Promise<TResult> {
  const transaction = (db as { transaction?: unknown }).transaction;
  if (typeof transaction === 'function') {
    return await (transaction as (callback: (tx: TDb) => Promise<TResult>) => Promise<TResult>)
      .call(db, fn);
  }

  return await fn(db);
}
