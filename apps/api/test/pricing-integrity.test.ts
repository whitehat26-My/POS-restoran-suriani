/**
 * Prices come from the menu, never from the phone.
 *
 * `unit_price_sen` is already snapshotted server-side, but modifier price
 * deltas were being taken straight from the request body — so a customer
 * could name their own discount. These tests exist so that hole cannot
 * reopen quietly.
 */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

import { createTenant, auth } from "./helpers";

describe("a customer cannot set their own price", () => {
  it("ignores a forged modifier price delta", async () => {
    const a = await createTenant("Suriani");

    const res = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${a.qrToken}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            {
              menuItemId: a.itemId,
              qty: 1,
              // A price invented by the client. RM10 off a RM12 dish.
              modifiers: [{ label: "Diskaun", priceDeltaSen: -1000 }],
            },
          ],
        }),
      },
    );

    // Either the order is refused, or it is priced honestly — but it must
    // never cost less than the menu says.
    if (res.status === 201) {
      const placed = (await res.json()) as { totalSen: number };
      expect(placed.totalSen).toBe(a.itemPriceSen);
    } else {
      expect(res.status).toBe(400);
    }

    const orders = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/orders`, {
        headers: auth(a),
      })
    ).json()) as { orders: { totalSen: number }[] };

    for (const order of orders.orders) {
      expect(order.totalSen).toBeGreaterThanOrEqual(a.itemPriceSen);
    }
  });

  it("rejects a free-text label smuggled in as a modifier", async () => {
    const a = await createTenant("Suriani");

    const res = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${a.qrToken}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [
            {
              menuItemId: a.itemId,
              qty: 1,
              modifiers: [{ label: "Percuma", priceDeltaSen: 0 }],
            },
          ],
        }),
      },
    );

    // Even a zero-priced label must not be accepted from the client: it
    // would print on the kitchen ticket as though the restaurant offered it.
    expect(res.status).toBe(400);
  });
});
