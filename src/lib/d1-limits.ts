/**
 * Cloudflare D1 caps a single SQL statement at 100 bound parameters.
 *
 * Multi-row inserts and `IN (...)` lists must therefore be chunked. Keep one
 * slot free for a companion predicate (type/status/etc.) when chunking an
 * `IN` list, and leave headroom for the correlated subqueries used by
 * `typecho_metas` counter updates.
 *
 * https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** Safe `IN (...)` chunk size when one companion parameter is bound. */
export const D1_SAFE_IN_LIST_SIZE = D1_MAX_BOUND_PARAMS - 1;

/**
 * Bound parameters emitted by one row of the relevant multi-row inserts.
 *
 * Drizzle includes table columns that carry defaults, so `typecho_metas` rows
 * bind name/slug/type/count/order/parent (six values; `mid` and `description`
 * are literal NULLs). `typecho_relationships` binds cid/mid.
 */
export const D1_INSERT_ROW_PARAMS = {
  metas: 6,
  relationships: 2,
} as const;

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError('chunk size must be a positive integer');
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Chunk rows so one multi-row INSERT stays within the D1 parameter cap. */
export function chunkInsertRows<T>(
  rows: readonly T[],
  paramsPerRow: number,
  reservedParams = 0,
): T[][] {
  const budget = D1_MAX_BOUND_PARAMS - Math.max(0, Math.floor(reservedParams));
  const size = Math.max(1, Math.floor(budget / paramsPerRow));
  return chunkArray(rows, size);
}
