/**
 * Counting the drawer.
 *
 * The only thing in this system that can tell an owner something is wrong
 * before the month's accounts do. The tests that matter are the unflattering
 * ones: a drawer that is short has to say so, and it has to say so by the
 * right amount.
 */
import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { createTenant, auth, authAs, type Tenant } from "./helpers";
import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
  SEED_STATIONS,
} from "../src/seed-data";

let n = 0;
const ulid = () => `ulid_shift_${String(++n).padStart(6, "0")}`;

const TZ = "Asia/Kuala_Lumpur";
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

async function trading(name: string) {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    tables: [
      { id: "tbl_a", label: "Meja 01", qrToken: `${t.qrToken}a` },
      { id: "tbl_b", label: "Meja 02", qrToken: `${t.qrToken}b` },
    ],
    modifierGroups: SEED_MODIFIER_GROUPS,
    stations: SEED_STATIONS,
    outletName: name,
  });
  return { t, stub };
}

/** Order and settle one table, returning what was taken. */
async function serveAndSettle(
  stub: Awaited<ReturnType<typeof trading>>["stub"],
  tableId: string,
  qty: number,
  method: "cash" | "duitnow_qr",
) {
  const placed = await stub.placeOrder({
    tableId,
    lines: [{ menuItemId: "itm_ng_kampung", qty }],
    clientUlid: ulid(),
    source: "counter",
  });
  if (!placed.ok) throw new Error(placed.error);
  const paid = await stub.recordPayment({
    sessionId: placed.order.sessionId,
    method,
    clientUlid: ulid(),
    ...(method === "cash" ? { tenderedSen: 10_000 } : {}),
  });
  if (!paid.ok) throw new Error(paid.error);
  return paid.amountSen;
}

const post = (t: Tenant, path: string, body: unknown, headers = auth(t)) =>
  SELF.fetch(`https://api.test/api/outlets/${t.outletId}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("the day's money", () => {
  it("adds up what came in, by how it came in", async () => {
    const { stub } = await trading("Suriani Day");
    const cash = await serveAndSettle(stub, "tbl_a", 2, "cash");
    const qr = await serveAndSettle(stub, "tbl_b", 3, "duitnow_qr");

    const day = await stub.dayCash({ date: today(), timeZone: TZ });
    expect(day.collectedSen).toBe(cash + qr);
    expect(day.byMethod).toEqual([
      { method: "duitnow_qr", totalSen: 2400, count: 1 },
      { method: "cash", totalSen: 1600, count: 1 },
    ]);
    // Only the cash is expected to be sitting in the drawer.
    expect(day.cashSen).toBe(1600);
  });

  it("expects the float plus the cash, and nothing else", async () => {
    const { t, stub } = await trading("Suriani Float");
    expect((await post(t, "day/open", { openingFloatSen: 20_000 })).status).toBe(200);
    await serveAndSettle(stub, "tbl_a", 2, "cash");
    await serveAndSettle(stub, "tbl_b", 3, "duitnow_qr");

    const day = await stub.dayCash({ date: today(), timeZone: TZ });
    // RM 200 float + RM 16 cash. The RM 24 taken by QR never touched the
    // drawer and must not be expected to be in it.
    expect(day.closing?.expectedCashSen).toBe(21_600);
  });

  it("balances when the count matches", async () => {
    const { t, stub } = await trading("Suriani Balanced");
    await post(t, "day/open", { openingFloatSen: 20_000 });
    await serveAndSettle(stub, "tbl_a", 2, "cash");

    const res = await post(t, "day/close", { cashCountedSen: 21_600 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      expectedCashSen: 21_600,
      countedCashSen: 21_600,
      varianceSen: 0,
    });
  });

  it("says short when it is short, by exactly the amount", async () => {
    const { t, stub } = await trading("Suriani Short");
    await post(t, "day/open", { openingFloatSen: 20_000 });
    await serveAndSettle(stub, "tbl_a", 2, "cash");

    // 60 sen missing from the drawer.
    const res = await post(t, "day/close", { cashCountedSen: 21_540 });
    expect(await res.json()).toMatchObject({ varianceSen: -60 });

    // And it is stored, not just returned — the owner reads it tomorrow.
    const day = await stub.dayCash({ date: today(), timeZone: TZ });
    expect(day.closing).toMatchObject({ varianceSen: -60, countedCashSen: 21_540 });
  });

  it("says over when it is over", async () => {
    const { t, stub } = await trading("Suriani Over");
    await post(t, "day/open", { openingFloatSen: 10_000 });
    await serveAndSettle(stub, "tbl_a", 1, "cash");
    const res = await post(t, "day/close", { cashCountedSen: 10_850 });
    // 10 000 + 800 = 10 800 expected, 10 850 counted.
    expect(await res.json()).toMatchObject({ varianceSen: 50 });
  });

  it("refuses to move the float after the drawer has been counted", async () => {
    const { t } = await trading("Suriani Locked");
    await post(t, "day/open", { openingFloatSen: 20_000 });
    await post(t, "day/close", { cashCountedSen: 20_000 });

    const res = await post(t, "day/open", { openingFloatSen: 5_000 });
    // Otherwise the variance becomes whatever anybody wants it to be.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "already_closed" });
  });

  it("leaves a voided payment out of what the drawer should hold", async () => {
    const { t, stub } = await trading("Suriani VoidDay");
    await post(t, "day/open", { openingFloatSen: 10_000 });
    const placed = await stub.placeOrder({
      tableId: "tbl_a",
      lines: [{ menuItemId: "itm_ng_kampung", qty: 2 }],
      clientUlid: ulid(),
      source: "counter",
    });
    if (!placed.ok) throw new Error(placed.error);
    const paid = await stub.recordPayment({
      sessionId: placed.order.sessionId,
      method: "cash",
      tenderedSen: 2000,
      clientUlid: ulid(),
    });
    if (!paid.ok) throw new Error(paid.error);

    await stub.voidPayment({ paymentId: paid.paymentId, reason: "salah tekan" });
    const day = await stub.dayCash({ date: today(), timeZone: TZ });
    expect(day.collectedSen).toBe(0);
    expect(day.closing?.expectedCashSen).toBe(10_000);
  });

  it("is any staff member's job, not only the owner's", async () => {
    const { t } = await trading("Suriani CashierCloses");
    // Whoever is on the counter at closing time counts the drawer.
    expect(
      (await post(t, "day/open", { openingFloatSen: 5000 }, await authAs(t, "cashier"))).status,
    ).toBe(200);
    expect(
      (await post(t, "day/close", { cashCountedSen: 5000 }, await authAs(t, "cashier"))).status,
    ).toBe(200);
  });

  it("records who closed it", async () => {
    const { t, stub } = await trading("Suriani Who");
    await post(t, "day/close", { cashCountedSen: 0 });
    const audit = await stub.recentAudit(10);
    const closed = audit.find((a) => a.action === "day.closed");
    expect(closed).toBeDefined();
    expect(closed?.userId).toBeTruthy();
  });
});
