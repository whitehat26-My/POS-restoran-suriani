/**
 * Ordering edge cases that only show up at realistic sizes.
 */
import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { createTenant, auth } from "./helpers";
import { batchForSql } from "../src/lib/chunk";
import { id } from "../src/lib/ids";

describe("bound-parameter budgeting", () => {
  it("never exceeds the 100 bound-parameter cap", () => {
    for (const columns of [1, 5, 9, 20, 50]) {
      for (const rowCount of [1, 11, 12, 40, 137]) {
        const rows = Array.from({ length: rowCount }, (_, i) => i);
        const batches = batchForSql(rows, columns);

        expect(batches.flat()).toEqual(rows); // nothing lost or duplicated
        for (const batch of batches) {
          expect(batch.length * columns).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe("a big family order", () => {
  it("accepts far more lines than fit in one INSERT", async () => {
    const a = await createTenant("Suriani");

    // Give the outlet a wide menu.
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: id("item"),
      categoryId: "cat_wide",
      nameMs: `Hidangan ${i + 1}`,
      nameEn: `Dish ${i + 1}`,
      priceSen: 500 + i * 10,
      prepMinutes: 8,
    }));

    const stub = env.OUTLET.get(env.OUTLET.idFromName(a.doId));
    await stub.installSeed({
      categories: [
        { id: "cat_wide", nameMs: "Lain-lain", nameEn: "Other", sortOrder: 9 },
      ],
      items,
      tables: [],
    });

    // 20 lines × 9 columns = 180 bound parameters. As a single INSERT this
    // exceeds SQLite's cap and the whole order fails — which is exactly what
    // one big table ordering for the family looks like.
    const res = await SELF.fetch(
      `https://api.test/t/${a.outletId}/${a.qrToken}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: items.map((item) => ({ menuItemId: item.id, qty: 1 })),
        }),
      },
    );

    expect(res.status).toBe(201);

    const placed = (await res.json()) as { totalSen: number };
    const expected = items.reduce((sum, i) => sum + i.priceSen, 0);
    expect(placed.totalSen).toBe(expected);

    // And every line actually landed — a partially written order would be
    // worse than a rejected one.
    const orders = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/orders`, {
        headers: auth(a),
      })
    ).json()) as { orders: { totalSen: number }[] };
    expect(orders.orders).toHaveLength(1);
    expect(orders.orders[0]!.totalSen).toBe(expected);
  });
});
