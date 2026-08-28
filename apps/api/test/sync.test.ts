/**
 * Replaying a tablet's op log.
 *
 * This is where the offline promise is either kept or quietly broken. The
 * tests that matter are the ugly ones: the same batch sent twice, an op that
 * can never succeed, an order for a dish that was 86'd while the line was
 * down, and a sale that must land on the night it happened rather than on the
 * morning it synced.
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
import type { SyncOp, SyncOpResult } from "../src/outlet/OutletDO";

let n = 0;
const ulid = () => `ulid_test_${String(++n).padStart(6, "0")}`;

async function outlet(name: string) {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    tables: [{ id: "tbl_sync", label: "Meja 03", qrToken: `${t.qrToken}s` }],
    modifierGroups: SEED_MODIFIER_GROUPS,
    stations: SEED_STATIONS,
    outletName: name,
  });
  return { t, stub };
}

const placeOp = (over: Partial<SyncOp> = {}): SyncOp => ({
  clientUlid: ulid(),
  deviceId: "dev_tablet",
  at: Date.now(),
  body: {
    kind: "order.place",
    tableId: "tbl_sync",
    lines: [{ menuItemId: "itm_ng_kampung", qty: 2 }],
    expectedTotalSen: 1600,
  },
  ...over,
});

async function sync(t: Tenant, ops: SyncOp[], headers = auth(t)) {
  const res = await SELF.fetch(
    `https://api.test/api/outlets/${t.outletId}/sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ ops }),
    },
  );
  return {
    status: res.status,
    body: (await res.json()) as { results?: SyncOpResult[]; error?: string },
  };
}

const ordersOf = async (t: Tenant) =>
  (
    (await (
      await SELF.fetch(`https://api.test/api/outlets/${t.outletId}/orders`, {
        headers: auth(t),
      })
    ).json()) as { orders: { id: string; totalSen: number; status: string }[] }
  ).orders;

describe("replaying an op log", () => {
  it("applies a batch in order and bills the server's own prices", async () => {
    const { t } = await outlet("Suriani Sync");

    const place = placeOp();
    const { status, body } = await sync(t, [place]);
    expect(status).toBe(200);
    expect(body.results?.[0]).toMatchObject({
      clientUlid: place.clientUlid,
      status: "applied",
    });

    const orders = await ordersOf(t);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.totalSen).toBe(1600);
  });

  it("bills once when the tablet loses the reply and retries", async () => {
    const { t } = await outlet("Suriani Retry");
    const batch = [placeOp(), placeOp()];

    const first = await sync(t, batch);
    expect(first.body.results?.map((r) => r.status)).toEqual([
      "applied",
      "applied",
    ]);

    // Same ULIDs, second attempt — the reply to the first never arrived.
    const second = await sync(t, batch);
    expect(second.body.results?.map((r) => r.status)).toEqual([
      "duplicate",
      "duplicate",
    ]);

    expect(await ordersOf(t)).toHaveLength(2);
  });

  it("keeps a whole order together and in order with what follows it", async () => {
    const { t } = await outlet("Suriani Order");

    const place = placeOp();
    const { body } = await sync(t, [place]);
    const orderId = body.results![0]!.orderId!;

    // "serve" arrives in the same batch as "place" on a real reconnect.
    const serve: SyncOp = {
      clientUlid: ulid(),
      deviceId: "dev_tablet",
      at: Date.now(),
      body: { kind: "order.serve", orderId },
    };
    const second = await sync(t, [serve]);
    expect(second.body.results?.[0]!.status).toBe("applied");

    const orders = await ordersOf(t);
    expect(orders[0]!.status).toBe("served");
  });

  it("records a sale on the night it happened, not the morning it synced", async () => {
    const { t, stub } = await outlet("Suriani Night");

    // Three nights ago at 23:30 Kuala Lumpur time, which is 15:30 UTC the
    // same day — so UTC and the restaurant agree here, and the only way the
    // sale lands on today is if the replay ignored the till's clock.
    const threeNightsAgo = new Date(Date.now() - 3 * 86_400_000);
    threeNightsAgo.setUTCHours(15, 30, 0, 0);
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(threeNightsAgo);

    await sync(t, [placeOp({ at: threeNightsAgo.getTime() })]);

    const { days } = await stub.dailySales({
      timeZone: "Asia/Kuala_Lumpur",
      days: 92,
    });
    const byDate = new Map(days.map((d) => [d.date, d]));
    expect(byDate.get(localDate)?.salesSen).toBe(1600);
    // The morning it synced must show nothing.
    expect(days).toHaveLength(1);
  });

  it("records an order for a dish that ran out while the line was down", async () => {
    const { t, stub } = await outlet("Suriani 86");

    // The kitchen ran out at 8pm and the till 86'd it; the order was taken
    // at 7:30. Refusing it now means serving a plate nobody is billed for.
    await stub.setItemAvailability({
      itemId: "itm_ng_kampung",
      available: false,
    });

    const { body } = await sync(t, [
      placeOp({ at: Date.now() - 30 * 60_000 }),
    ]);
    expect(body.results?.[0]!.status).toBe("applied");
    expect(await ordersOf(t)).toHaveLength(1);

    // But a fresh order over the counter is still refused.
    const live = await SELF.fetch(
      `https://api.test/api/t/${t.outletId}/${t.qrToken}s/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [{ menuItemId: "itm_ng_kampung", qty: 1 }],
        }),
      },
    );
    expect(live.status).toBe(400);
  });

  it("still refuses a live counter order for a dish that is 86'd", async () => {
    const { t, stub } = await outlet("Suriani Live 86");
    await stub.setItemAvailability({
      itemId: "itm_ng_kampung",
      available: false,
    });

    // Taken just now, not replayed. The server decides which is which from
    // the op's age — a client cannot switch the rule off by asking.
    const { body } = await sync(t, [placeOp({ at: Date.now() })]);
    expect(body.results?.[0]).toMatchObject({
      status: "rejected",
      error: "unavailable",
    });
    expect(await ordersOf(t)).toHaveLength(0);
  });

  it("notes it when the till's total and the server's disagree", async () => {
    const { t, stub } = await outlet("Suriani Divergence");

    // The till showed RM 14.00 because the owner raised the price during the
    // outage. The server bills its own RM 16.00 and records the gap.
    const wrong = placeOp({ at: Date.now() - 30 * 60_000 });
    (wrong.body as { expectedTotalSen: number }).expectedTotalSen = 1400;
    await sync(t, [wrong]);

    const audit = await stub.recentAudit(20);
    const divergence = audit.find((a) => a.action === "order.price_divergence");
    expect(divergence).toBeDefined();
    expect(JSON.parse(divergence!.detail!)).toMatchObject({
      tillTotalSen: 1400,
      serverTotalSen: 1600,
    });
  });

  it("rejects what can never succeed instead of blocking the queue", async () => {
    const { t } = await outlet("Suriani Rejects");

    const doomed = placeOp({
      body: {
        kind: "order.place",
        tableId: "tbl_does_not_exist",
        lines: [{ menuItemId: "itm_ng_kampung", qty: 1 }],
        expectedTotalSen: 800,
      },
    });
    const good = placeOp();

    const { body } = await sync(t, [doomed, good]);
    expect(body.results?.map((r) => r.status)).toEqual(["rejected", "applied"]);
    // The good one behind it still landed — that is the whole point.
    expect(await ordersOf(t)).toHaveLength(1);
  });

  it("treats a bill someone else already closed as done, not as an error", async () => {
    const { t, stub } = await outlet("Suriani Closed");
    const { body } = await sync(t, [placeOp()]);
    const orderId = body.results![0]!.orderId!;

    const detail = await stub.getSessionDetail("tbl_sync");
    const sessionId = detail!.session!.id;
    expect(orderId).toBeTruthy();

    const first = await sync(t, [
      { clientUlid: ulid(), at: Date.now(), body: { kind: "session.close", sessionId } },
    ]);
    expect(first.body.results?.[0]!.status).toBe("applied");

    // A second tablet closed the same table before this one reconnected.
    const second = await sync(t, [
      { clientUlid: ulid(), at: Date.now(), body: { kind: "session.close", sessionId } },
    ]);
    expect(second.body.results?.[0]!.status).toBe("duplicate");
  });

  it("refuses a malformed op without dropping the batch", async () => {
    const { t } = await outlet("Suriani Malformed");
    const { body } = await sync(t, [
      { clientUlid: "", at: 0 } as unknown as SyncOp,
      placeOp(),
    ]);
    expect(body.results?.map((r) => r.status)).toEqual(["rejected", "applied"]);
  });
});

describe("sync is a tenant door like every other outlet route", () => {
  it("answers 404 to another organisation", async () => {
    const { t } = await outlet("Suriani A");
    const stranger = await createTenant("Warung Lain");

    const { status } = await sync(t, [placeOp()], auth(stranger));
    expect(status).toBe(404);
    expect(await ordersOf(t)).toHaveLength(0);
  });

  it("is open to a cashier, who is the one holding the tablet", async () => {
    const { t } = await outlet("Suriani Cashier");
    const { status } = await sync(t, [placeOp()], await authAs(t, "cashier"));
    expect(status).toBe(200);
  });

  it("refuses a batch big enough to hold the outlet hostage", async () => {
    const { t } = await outlet("Suriani Flood");
    const ops = Array.from({ length: 201 }, () => placeOp());
    const { status } = await sync(t, ops);
    expect(status).toBe(413);
  });
});
