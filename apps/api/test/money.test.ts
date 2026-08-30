/**
 * Money arithmetic, and the Malaysian rounding rule.
 *
 * The rounding tests are here rather than filed under "nice to have" because
 * the failure mode is silent: a rule applied to the wrong payment method, or
 * in the wrong direction, shows up as a few sen of unexplained variance in
 * the drawer every single day, and by the time anyone investigates there are
 * months of it.
 */
import { describe, expect, it } from "vitest";

import {
  cashRoundingSen,
  formatMYR,
  lineTotalSen,
  roundToNearest5Sen,
} from "@suriani/core/money";

describe("cash rounding to the nearest 5 sen", () => {
  it("rounds 1, 2, 6 and 7 down and 3, 4, 8 and 9 up", () => {
    // Bank Negara's own worked example: RM 82.01 → RM 82.00, RM 82.04 → 82.05.
    expect(roundToNearest5Sen(8201)).toBe(8200);
    expect(roundToNearest5Sen(8204)).toBe(8205);

    const table: [number, number][] = [
      [3230, 3230], [3231, 3230], [3232, 3230], [3233, 3235], [3234, 3235],
      [3235, 3235], [3236, 3235], [3237, 3235], [3238, 3240], [3239, 3240],
    ];
    for (const [given, expected] of table) {
      expect(roundToNearest5Sen(given)).toBe(expected);
    }
  });

  it("leaves an amount that is already a multiple of 5 sen alone", () => {
    // The whole current menu is priced this way, so this is the common case.
    for (const sen of [0, 5, 250, 600, 1300, 1690, 3200]) {
      expect(roundToNearest5Sen(sen)).toBe(sen);
      expect(cashRoundingSen(sen)).toBe(0);
    }
  });

  it("never moves an amount by more than 2 sen, in either direction", () => {
    // The property that matters: rounding is a courtesy over coins, not a
    // place where money can go missing. 2000 consecutive amounts is every
    // residue many times over.
    for (let sen = 0; sen < 2000; sen++) {
      const delta = cashRoundingSen(sen);
      expect(Math.abs(delta)).toBeLessThanOrEqual(2);
      expect(roundToNearest5Sen(sen) % 5).toBe(0);
    }
  });

  it("rounds a refund the same distance, not towards zero", () => {
    // Math.round breaks ties away from zero for positives and towards zero
    // for negatives, so a naive implementation quietly rounds a reversal the
    // wrong way and the two no longer cancel.
    expect(roundToNearest5Sen(-3232)).toBe(-3230);
    expect(roundToNearest5Sen(-3233)).toBe(-3235);
    expect(roundToNearest5Sen(-3232)).toBe(-roundToNearest5Sen(3232));
  });

  it("refuses a float, like every other amount in the system", () => {
    expect(() => roundToNearest5Sen(32.3)).toThrow(TypeError);
    expect(() => cashRoundingSen(0.1 + 0.2)).toThrow(TypeError);
  });
});

describe("the arithmetic the rounding sits on", () => {
  it("prices a line with its modifiers", () => {
    // Teh tarik with the takeaway surcharge, twice.
    expect(lineTotalSen(250, 2, [{ label: "Bungkus (ais)", priceDeltaSen: 50 }])).toBe(600);
  });

  it("formats sen as ringgit without ever going through a float", () => {
    expect(formatMYR(3230)).toBe("RM 32.30");
    expect(formatMYR(0)).toBe("RM 0.00");
    expect(formatMYR(-60)).toBe("-RM 0.60");
    expect(formatMYR(123456)).toBe("RM 1,234.56");
  });
});
