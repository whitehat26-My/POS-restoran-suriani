import { describe, expect, it } from "vitest";

import {
  assertSen,
  formatMYR,
  lineTotalSen,
  sumSen,
} from "../src/lib/money";

describe("money is always integer sen", () => {
  it("rejects a float amount outright", () => {
    expect(() => assertSen(12.3)).toThrow(TypeError);
    expect(() => lineTotalSen(12.5, 1)).toThrow(TypeError);
    expect(() =>
      lineTotalSen(1200, 1, [{ label: "Telur", priceDeltaSen: 1.5 }]),
    ).toThrow(TypeError);
  });

  it("rejects a nonsense quantity", () => {
    expect(() => lineTotalSen(1200, 0)).toThrow(RangeError);
    expect(() => lineTotalSen(1200, -1)).toThrow(RangeError);
    expect(() => lineTotalSen(1200, 1.5)).toThrow(RangeError);
  });

  it("applies modifiers before multiplying by quantity", () => {
    // (RM12.00 + RM1.50 telur) × 3 = RM40.50
    expect(
      lineTotalSen(1200, 3, [{ label: "Telur", priceDeltaSen: 150 }]),
    ).toBe(4050);
  });

  it("stays exact where floating point would not", () => {
    // The classic failure: 0.1 + 0.2 !== 0.3. In sen it is just 10 + 20.
    expect(sumSen([10, 20])).toBe(30);

    // A hundred plates of RM12.30 is exactly RM1,230.00, not 1229.9999...
    const hundred = Array.from({ length: 100 }, () => 1230);
    expect(sumSen(hundred)).toBe(123_000);
    expect(formatMYR(sumSen(hundred))).toBe("RM 1,230.00");
  });

  it("formats Malaysian ringgit for display", () => {
    expect(formatMYR(0)).toBe("RM 0.00");
    expect(formatMYR(5)).toBe("RM 0.05");
    expect(formatMYR(1200)).toBe("RM 12.00");
    expect(formatMYR(1_234_567)).toBe("RM 12,345.67");
    expect(formatMYR(-350)).toBe("-RM 3.50");
  });
});
