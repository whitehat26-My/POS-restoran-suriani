/**
 * The owner's daily record.
 *
 * The test that matters most here is the day boundary. Malaysia is UTC+8, so
 * an order taken at 8pm is 12:00 the *next day* in UTC — bucket by UTC and
 * every evening's takings quietly land on tomorrow. That is the kind of bug
 * that is invisible until someone tries to reconcile a week.
 */
import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";

import { createTenant, auth, authAs, type Tenant } from "./helpers";
import { SEED_CATEGORIES, SEED_ITEMS, SEED_MODIFIER_GROUPS } from "../src/seed-data";

const KL = "Asia/Kuala_Lumpur";

async function outletWithMenu(name: string) {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    tables: [],
    modifierGroups: SEED_MODIFIER_GROUPS,
  });
  return { t, stub };
}

type Stub = DurableObjectStub<import("../src/outlet/OutletDO").OutletDO>;

/**
 * Place an order and then move it to a chosen instant.
 *
 * Rewriting placed_at afterwards is the only way to test a date range without
 * making the suite wait a day, and it still exercises the same read path real
 * history goes through. Done through the object's own storage rather than by
 * adding a test-only method to the class that ships.
 */
async function orderAt(
  stub: Stub,
  tableId: string,
  at: string,
  lines: { menuItemId: string; qty: number; modifierOptionIds?: string[] }[],
) {
  const placed = await stub.placeOrder({ tableId, lines });
  if (!placed.ok) throw new Error(`order failed: ${placed.error}`);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE orders SET placed_at = ? WHERE id = ?",
      Date.parse(at),
      placed.order.orderId,
    );
  });
  return placed.order;
}

async function voidOrder(stub: Stub, orderId: string) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE orders SET status = 'voided' WHERE id = ?",
      orderId,
    );
  });
}

describe("daily record", () => {
  it("puts an evening order on the restaurant's day, not on UTC's", async () => {
    const { t, stub } = await outletWithMenu("Suriani Days");
    await stub.installSeed({
      categories: [],
      items: [],
      tables: [{ id: "tbl_d", label: "Meja 01", qrToken: t.qrToken + "d" }],
    });

    // 20:00 in KL on the 18th — which is 12:00 UTC on the 18th.
    await orderAt(stub, "tbl_d", "2026-08-18T12:00:00Z", [
      { menuItemId: "itm_nl_biasa", qty: 1 },
    ]);
    // 01:00 in KL on the 19th — which is 17:00 UTC on the *18th*.
    await orderAt(stub, "tbl_d", "2026-08-18T17:00:00Z", [
      { menuItemId: "itm_roti_kosong", qty: 1 },
    ]);

    const { days } = await stub.dailySales({ timeZone: KL, days: 90 });
    const byDate = new Map(days.map((d) => [d.date, d]));

    expect(byDate.get("2026-08-18")?.salesSen).toBe(600);
    expect(byDate.get("2026-08-19")?.salesSen).toBe(180);
  });

  it("counts modifiers, and never counts a voided order", async () => {
    const { t, stub } = await outletWithMenu("Suriani Money");
    await stub.installSeed({
      categories: [],
      items: [],
      tables: [{ id: "tbl_m", label: "Meja 02", qrToken: t.qrToken + "m" }],
    });

    // RM 2.50 teh tarik + 50 sen ais, twice over.
    await orderAt(stub, "tbl_m", "2026-07-01T04:00:00Z", [
      { menuItemId: "itm_min_tehtarik", qty: 2, modifierOptionIds: ["mo_tehtarik_ais"] },
    ]);
    const voided = await orderAt(stub, "tbl_m", "2026-07-01T05:00:00Z", [
      { menuItemId: "itm_nl_biasa", qty: 1 },
    ]);
    await voidOrder(stub, voided.orderId);

    const summary = await stub.daySummary({ date: "2026-07-01", timeZone: KL });
    expect(summary.salesSen).toBe(600);
    expect(summary.itemCount).toBe(2);
    expect(summary.orderCount).toBe(1);
    expect(summary.billCount).toBe(1);
  });

  it("breaks a day down so the parts add up to the whole", async () => {
    const { t, stub } = await outletWithMenu("Suriani Breakdown");
    await stub.installSeed({
      categories: [],
      items: [],
      tables: [{ id: "tbl_b", label: "Meja 03", qrToken: t.qrToken + "b" }],
    });

    await orderAt(stub, "tbl_b", "2026-06-10T04:30:00Z", [
      { menuItemId: "itm_ng_kampung", qty: 2 },
    ]);
    await orderAt(stub, "tbl_b", "2026-06-10T09:15:00Z", [
      { menuItemId: "itm_min_kopio", qty: 3, modifierOptionIds: ["mo_kopio_panas"] },
    ]);

    const s = await stub.daySummary({ date: "2026-06-10", timeZone: KL });

    expect(s.salesSen).toBe(800 * 2 + 200 * 3);
    expect(s.byHour.map((h) => h.hour)).toEqual([12, 17]);
    expect(s.byHour.reduce((sum, h) => sum + h.salesSen, 0)).toBe(s.salesSen);
    expect(s.byCategory.reduce((sum, c) => sum + c.salesSen, 0)).toBe(s.salesSen);
    expect(s.byItem.reduce((sum, i) => sum + i.salesSen, 0)).toBe(s.salesSen);

    // Sorted by money, so the owner reads the answer off the top.
    expect(s.byItem[0]?.menuItemId).toBe("itm_ng_kampung");
    expect(
      s.byCategory.find((c) => c.categoryId === "cat_minum")?.qty,
    ).toBe(3);
  });

  it("is the owner's, not the counter's", async () => {
    const { t } = await outletWithMenu("Suriani Roles");
    const url = `https://api.test/api/outlets/${t.outletId}/reports/daily`;

    for (const role of ["owner", "manager"] as const) {
      const res = await SELF.fetch(url, { headers: await authAs(t, role) });
      expect(res.status).toBe(200);
    }

    // A cashier is legitimately here, just not entitled to the takings.
    const cashier = await SELF.fetch(url, {
      headers: await authAs(t, "cashier"),
    });
    expect(cashier.status).toBe(403);

    // Another organisation may not even learn that this outlet exists.
    const stranger: Tenant = await createTenant("Warung Lain");
    const other = await SELF.fetch(url, { headers: auth(stranger) });
    expect(other.status).toBe(404);

    // And a malformed date is a 400, not a 500 or an empty day.
    const bad = await SELF.fetch(`${url}/18-08-2026`, { headers: auth(t) });
    expect(bad.status).toBe(400);
  });

  it("serves the day over HTTP with the outlet's own timezone", async () => {
    const { t, stub } = await outletWithMenu("Suriani Http");
    await stub.installSeed({
      categories: [],
      items: [],
      tables: [{ id: "tbl_h", label: "Meja 04", qrToken: t.qrToken + "h" }],
    });
    await orderAt(stub, "tbl_h", "2026-05-05T16:30:00Z", [
      { menuItemId: "itm_min_milo", qty: 1, modifierOptionIds: ["mo_milo_panas"] },
    ]);

    // 16:30 UTC is 00:30 on the 6th in KL.
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/reports/daily/2026-05-06`,
      { headers: auth(t) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { salesSen: number }).toMatchObject({
      date: "2026-05-06",
      salesSen: 300,
    });
  });
});
