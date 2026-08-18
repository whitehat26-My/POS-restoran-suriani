/**
 * Money.
 *
 * Every amount in this system is an integer number of **sen**. There are no
 * floating point amounts anywhere, ever.
 *
 * SQLite has no decimal type, so a "RM 12.30" stored as a float is really
 * 12.299999999999999. Add a few hundred of those together and a day's takings
 * disagree with the cash drawer by a sen or two, which is exactly the kind of
 * discrepancy that destroys trust in a till.
 */

export type Sen = number;

export interface Modifier {
  label: string;
  priceDeltaSen: Sen;
}

/** Guard against a float sneaking in through JSON or an API caller. */
export function assertSen(value: number, what = "amount"): Sen {
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `${what} must be an integer number of sen, got ${value}`,
    );
  }
  return value;
}

/** Total for one order line: (unit price + modifiers) × quantity. */
export function lineTotalSen(
  unitPriceSen: Sen,
  qty: number,
  modifiers: readonly Modifier[] = [],
): Sen {
  assertSen(unitPriceSen, "unit price");
  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError(`quantity must be a positive integer, got ${qty}`);
  }
  const modifierTotal = modifiers.reduce(
    (sum, m) => sum + assertSen(m.priceDeltaSen, "modifier price"),
    0,
  );
  return (unitPriceSen + modifierTotal) * qty;
}

export function sumSen(amounts: readonly Sen[]): Sen {
  return amounts.reduce((sum, a) => sum + assertSen(a), 0);
}

/** "RM 12.30" — display only. Never parse this back into an amount. */
export function formatMYR(sen: Sen): string {
  assertSen(sen);
  const negative = sen < 0;
  const abs = Math.abs(sen);
  const ringgit = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}RM ${ringgit.toLocaleString("en-MY")}.${cents}`;
}
