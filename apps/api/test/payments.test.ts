/**
 * Taking money.
 *
 * The tests worth having here are the ones about arithmetic nobody would
 * notice going wrong: a bill settled twice, a split that adds up to a sen
 * more than the food, a rounding applied to a payment it should not touch, a
 * discount that quietly becomes larger than the bill. Each of those shows up
 * as a drawer that is short at the end of a day and no way to find out why.
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
const ulid = () => `ulid_pay_${String(++n).padStart(6, "0")}`;

/** An outlet with one table and one order on it, ready to be paid for. */
async function billed(name: string, lines?: { menuItemId: string; qty: number }[]) {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    tables: [{ id: "tbl_pay", label: "Meja 07", qrToken: `${t.qrToken}p` }],
    modifierGroups: SEED_MODIFIER_GROUPS,
    stations: SEED_STATIONS,
    outletName: name,
  });

  const placed = await stub.placeOrder({
    tableId: "tbl_pay",
    // Nasi Goreng Kampung is RM 8.00, so two make a clean RM 16.00.
    lines: lines ?? [{ menuItemId: "itm_ng_kampung", qty: 2 }],
    clientUlid: ulid(),
    source: "counter",
  });
  if (!placed.ok) throw new Error(`could not place the order: ${placed.error}`);
  return { t, stub, sessionId: placed.order.sessionId };
}

const pay = async (
  t: Tenant,
  sessionId: string,
  body: Record<string, unknown>,
  headers = auth(t),
) => {
  const res = await SELF.fetch(
    `https://api.test/api/outlets/${t.outletId}/sessions/${sessionId}/payments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ clientUlid: ulid(), ...body }),
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> };
};

describe("settling a bill", () => {
  it("takes cash, gives change, and closes the table", async () => {
    const { t, stub, sessionId } = await billed("Suriani Cash");

    const { status, body } = await pay(t, sessionId, {
      method: "cash",
      tenderedSen: 5000,
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      amountSen: 1600,
      changeSen: 3400,
      balanceSen: 0,
      settled: true,
      receiptNo: 1,
    });

    // The table is free and the bill is gone from the floor.
    const detail = await stub.getSessionDetail("tbl_pay");
    expect(detail?.session).toBeNull();
  });

  it("refuses a second payment on a bill already settled", async () => {
    const { t, sessionId } = await billed("Suriani Twice");
    await pay(t, sessionId, { method: "cash", tenderedSen: 2000 });

    const second = await pay(t, sessionId, { method: "cash", tenderedSen: 2000 });
    // Two tills on one counter, both tapping settle. The Durable Object is
    // single-threaded, so the second one is told somebody beat it to it —
    // which is more use than "not found" for a table standing right there.
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "already_settled" });
  });

  it("bills once when the till loses the reply and retries", async () => {
    const { t, stub, sessionId } = await billed("Suriani Retry");
    const clientUlid = ulid();
    const send = () =>
      SELF.fetch(
        `https://api.test/api/outlets/${t.outletId}/sessions/${sessionId}/payments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth(t) },
          body: JSON.stringify({ method: "cash", tenderedSen: 2000, clientUlid }),
        },
      );

    const first = (await (await send()).json()) as { paymentId: string };
    const again = await send();
    const replay = (await again.json()) as { paymentId: string; duplicate: boolean };

    expect(again.status).toBe(200);
    expect(replay.duplicate).toBe(true);
    // The same payment, not a second one — enforced by a UNIQUE index rather
    // than by the application remembering to check.
    expect(replay.paymentId).toBe(first.paymentId);
    expect(await stub.dayCash({ date: today(), timeZone: "Asia/Kuala_Lumpur" })).toMatchObject({
      collectedSen: 1600,
    });
  });

  it("refuses cash that does not cover what is owed", async () => {
    const { t, sessionId } = await billed("Suriani Short");
    const res = await pay(t, sessionId, { method: "cash", tenderedSen: 1000 });
    // Recording RM 16 when RM 10 was handed over is how a drawer ends a day
    // short with nothing to explain it.
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "short_tender" });
  });

  it("takes DuitNow to the sen, with no drawer and no rounding", async () => {
    const { t, sessionId } = await billed("Suriani QR");
    const { body } = await pay(t, sessionId, {
      method: "duitnow_qr",
      reference: "MB2408281234",
    });
    expect(body).toMatchObject({ amountSen: 1600, roundingSen: 0, settled: true });
  });
});

describe("the 5 sen rounding, where it applies and where it must not", () => {
  // Roti Kosong is RM 1.80. Three of them, less a three sen discount, lands
  // on RM 5.37 — an amount that cannot be paid in coins any more.
  const oddBill = [{ menuItemId: "itm_roti_kosong", qty: 3 }];

  it("rounds a cash settlement down to the nearest 5 sen and records it", async () => {
    const { t, stub, sessionId } = await billed("Suriani Round", oddBill);
    const before = await stub.getSessionDetail("tbl_pay");
    expect(before?.session?.totalSen).toBe(540);

    await stub.applyDiscount({ sessionId, amountSen: 3, reason: "ujian" });
    const { body } = await pay(t, sessionId, { method: "cash", tenderedSen: 1000 });

    // 540 − 3 = 537, which rounds down to 535.
    expect(body).toMatchObject({ amountSen: 535, roundingSen: -2, changeSen: 465 });
  });

  it("does not round an electronic payment", async () => {
    const { t, stub, sessionId } = await billed("Suriani NoRound", oddBill);
    await stub.applyDiscount({ sessionId, amountSen: 3, reason: "ujian" });
    const { body } = await pay(t, sessionId, { method: "duitnow_qr" });
    // Rounding a card or QR payment up is the thing customers complain about
    // publicly, and it is not what the rule says.
    expect(body).toMatchObject({ amountSen: 537, roundingSen: 0 });
  });

  it("does not round an explicit part payment", async () => {
    const { t, sessionId } = await billed("Suriani PartRound", oddBill);
    const { body } = await pay(t, sessionId, {
      method: "cash",
      amountSen: 233,
      tenderedSen: 400,
    });
    // The cashier typed a number. Rounding is about the total of a bill, not
    // about every amount that passes through a drawer.
    expect(body).toMatchObject({ amountSen: 233, roundingSen: 0, changeSen: 167 });
  });
});

describe("splitting a bill", () => {
  it("takes several payments until the bill is settled", async () => {
    const { t, stub, sessionId } = await billed("Suriani Split");

    const first = await pay(t, sessionId, {
      method: "cash",
      amountSen: 1000,
      tenderedSen: 1000,
    });
    expect(first.body).toMatchObject({ settled: false, balanceSen: 600 });

    // The table stays on the floor, part paid, so nobody asks for the whole
    // amount again.
    const mid = await stub.getSessionDetail("tbl_pay");
    expect(mid?.session).toMatchObject({ paidSen: 1000, outstandingSen: 600 });

    const second = await pay(t, sessionId, { method: "duitnow_qr" });
    expect(second.body).toMatchObject({ settled: true, amountSen: 600, balanceSen: 0 });
    expect((await stub.getSessionDetail("tbl_pay"))?.session).toBeNull();
  });

  it("refuses a part payment larger than what is left", async () => {
    const { t, sessionId } = await billed("Suriani Overpay");
    const res = await pay(t, sessionId, { method: "cash", amountSen: 9999, tenderedSen: 9999 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "bad_amount" });
  });
});

describe("discounts", () => {
  const discount = (t: Tenant, sessionId: string, body: unknown, headers = auth(t)) =>
    SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/sessions/${sessionId}/discount`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    );

  it("comes off the bill and is recorded with who gave it and why", async () => {
    const { t, stub, sessionId } = await billed("Suriani Disc");

    const res = await discount(t, sessionId, { amountSen: 500, reason: "Pelanggan tetap" });
    expect(res.status).toBe(200);

    const detail = await stub.getSessionDetail("tbl_pay");
    expect(detail?.session).toMatchObject({
      totalSen: 1600,
      discountSen: 500,
      outstandingSen: 1100,
    });

    const audit = await stub.recentAudit(20);
    expect(audit.some((a) => a.action === "bill.discounted")).toBe(true);
  });

  it("refuses one without a reason", async () => {
    const { t, sessionId } = await billed("Suriani NoReason");
    const res = await discount(t, sessionId, { amountSen: 500, reason: "   " });
    // The difference between a discount and money going missing is that
    // somebody put their name to a reason.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "reason_required" });
  });

  it("refuses one bigger than what is still owed", async () => {
    const { t, sessionId } = await billed("Suriani TooMuch");
    const res = await discount(t, sessionId, { amountSen: 99_999, reason: "salah" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too_large" });
  });

  it("means sales and collections legitimately disagree", async () => {
    const { t, stub, sessionId } = await billed("Suriani Gap");
    await discount(t, sessionId, { amountSen: 600, reason: "Lambat" });
    await pay(t, sessionId, { method: "cash", tenderedSen: 1000 });

    const day = await stub.daySummary({ date: today(), timeZone: "Asia/Kuala_Lumpur" });
    // RM 16 of food left the kitchen; RM 10 reached the drawer. Both numbers
    // are right, and the difference is exactly the discount.
    expect(day.salesSen).toBe(1600);
    expect(day.collectedSen).toBe(1000);
    expect(day.discountSen).toBe(600);
  });
});

describe("voiding a payment", () => {
  it("reopens the bill and takes the money back out of the day", async () => {
    const { t, stub, sessionId } = await billed("Suriani Void");
    const { body } = await pay(t, sessionId, { method: "cash", tenderedSen: 10_000 });
    const paymentId = (body as unknown as { paymentId: string }).paymentId;

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/payments/${paymentId}/void`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(t) },
        body: JSON.stringify({ reason: "Tersalah tekan RM 100" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionReopened: true });

    // The table comes back with the full amount owing.
    const detail = await stub.getSessionDetail("tbl_pay");
    expect(detail?.session).toMatchObject({ outstandingSen: 1600, paidSen: 0 });

    const day = await stub.dayCash({ date: today(), timeZone: "Asia/Kuala_Lumpur" });
    expect(day.collectedSen).toBe(0);

    // And both halves of the mistake are on the record.
    const audit = await stub.recentAudit(20);
    expect(audit.some((a) => a.action === "payment.recorded")).toBe(true);
    expect(audit.some((a) => a.action === "payment.voided")).toBe(true);
  });

  it("is not something a cashier can do", async () => {
    const { t, sessionId } = await billed("Suriani VoidRole");
    const { body } = await pay(t, sessionId, { method: "cash", tenderedSen: 2000 });
    const paymentId = (body as unknown as { paymentId: string }).paymentId;

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/payments/${paymentId}/void`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authAs(t, "cashier")),
        },
        body: JSON.stringify({ reason: "cuba" }),
      },
    );
    // Taking money is a cashier's job. Making it disappear is not.
    expect(res.status).toBe(403);
  });

  it("refuses without a reason", async () => {
    const { t, sessionId } = await billed("Suriani VoidReason");
    const { body } = await pay(t, sessionId, { method: "cash", tenderedSen: 2000 });
    const paymentId = (body as unknown as { paymentId: string }).paymentId;

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/payments/${paymentId}/void`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(t) },
        body: JSON.stringify({ reason: "" }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("the tenant door, on money", () => {
  it("answers 404 when one organisation addresses another's outlet", async () => {
    const { t: a, sessionId } = await billed("Suriani A");
    const b = await createTenant("Suriani B");

    // B's credentials, A's outlet id. Every money route has to refuse, and
    // refuse with 404 rather than 403 — a 403 would confirm the outlet is
    // real, which is the one thing another tenant must not learn.
    for (const [method, path, body] of [
      ["POST", `sessions/${sessionId}/payments`, { method: "cash", tenderedSen: 100 }],
      ["POST", `sessions/${sessionId}/discount`, { amountSen: 100, reason: "x" }],
      ["POST", "day/open", { openingFloatSen: 100 }],
      ["POST", "day/close", { cashCountedSen: 100 }],
      ["GET", "day", null],
    ] as const) {
      const res = await SELF.fetch(
        `https://api.test/api/outlets/${a.outletId}/${path}`,
        {
          method,
          headers: { "Content-Type": "application/json", ...auth(b) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      expect([res.status, path]).toEqual([404, path]);
    }
  });

  it("lets a cashier take money, because that is the job", async () => {
    const { t, sessionId } = await billed("Suriani CashierPays");
    const res = await pay(
      t,
      sessionId,
      { method: "cash", tenderedSen: 2000 },
      await authAs(t, "cashier"),
    );
    expect(res.status).toBe(201);
  });
});

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
