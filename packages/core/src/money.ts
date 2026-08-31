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

/* ------------------------------------------------------------------ *
 * Cash rounding
 *
 * Malaysia withdrew the 1 sen coin, so a bill paid over the counter is
 * rounded to the nearest 5 sen: a total ending in 1, 2, 6 or 7 rounds down,
 * and one ending in 3, 4, 8 or 9 rounds up.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 *  - It applies to the **total of the bill**, never to individual items.
 *    Rounding each line would drift by sen across a big order.
 *  - It applies to **cash only**. An electronic payment is taken to the sen,
 *    and rounding one up is the kind of thing customers notice and complain
 *    about publicly.
 *
 * Every price on the current menu is already a multiple of 5 sen, so today
 * this is nearly always a no-op. It stops being one the moment a service
 * charge or SST is added, and by then it needs to already be right.
 * ------------------------------------------------------------------ */

/** The amount actually taken in cash for a bill of `sen`. */
export function roundToNearest5Sen(sen: Sen): Sen {
  assertSen(sen, "amount");
  // Math.round is not enough on its own: it breaks ties away from zero for
  // positives but towards zero for negatives, so a refund would round the
  // wrong way. Work on the magnitude and put the sign back.
  const sign = sen < 0 ? -1 : 1;
  const abs = Math.abs(sen);
  const remainder = abs % 5;
  const rounded = remainder < 3 ? abs - remainder : abs + (5 - remainder);
  return sign * rounded;
}

/**
 * The adjustment, as a signed amount.
 *
 * Recorded on the payment rather than folded silently into the total, so a
 * day's takings can be reconciled to the sen and nobody has to wonder where
 * two sen went.
 */
export function cashRoundingSen(sen: Sen): Sen {
  return roundToNearest5Sen(sen) - assertSen(sen, "amount");
}
