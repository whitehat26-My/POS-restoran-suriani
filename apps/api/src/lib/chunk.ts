/**
 * SQLite bound-parameter budgeting.
 *
 * Durable Object SQLite shares D1's limits, and both cap a single statement at
 * **100 bound parameters**. A multi-row INSERT binds one parameter per column
 * per row, so batches quietly stop working past a certain size — an order with
 * 12 lines, or a floor plan created 12 tables at a time.
 *
 * The failure mode is nasty: it works in every small test and breaks on the
 * first big family order. So batch inserts go through here rather than relying
 * on anyone remembering the arithmetic.
 */

/** Cloudflare's cap. */
const MAX_BOUND_PARAMS = 100;

/** Leaves room for a WHERE clause or an extra binding on the same statement. */
const SAFETY_MARGIN = 10;

/**
 * Split rows into batches that will not exceed the bound-parameter cap.
 *
 * @param rows            the rows to insert
 * @param columnsPerRow   how many columns each row binds
 */
export function batchForSql<T>(
  rows: readonly T[],
  columnsPerRow: number,
): T[][] {
  if (columnsPerRow < 1) throw new RangeError("columnsPerRow must be >= 1");

  const perBatch = Math.max(
    1,
    Math.floor((MAX_BOUND_PARAMS - SAFETY_MARGIN) / columnsPerRow),
  );

  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += perBatch) {
    batches.push(rows.slice(i, i + perBatch) as T[]);
  }
  return batches;
}
