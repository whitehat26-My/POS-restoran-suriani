/**
 * The till's realtime layer.
 *
 * The Durable Object that stores an order is the same object that announces
 * it, so these tests exercise the real thing: real sockets, real hibernation,
 * real broadcasts — inside workerd.
 */
import { describe, expect, it } from "vitest";
import { SELF, env, evictDurableObject } from "cloudflare:test";

import { createTenant, auth, type Tenant } from "./helpers";

interface WsEvent {
  type: string;
  [key: string]: unknown;
}

/** Connect to an outlet's socket and expose received events as a queue. */
async function connect(tenant: Tenant) {
  const res = await SELF.fetch(
    `https://api.test/api/outlets/${tenant.outletId}/ws`,
    { headers: { Upgrade: "websocket", ...auth(tenant) } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on 101 response");

  const queue: WsEvent[] = [];
  const waiters: ((e: WsEvent) => void)[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(event.data as string) as WsEvent;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });

  const next = (timeoutMs = 3000): Promise<WsEvent> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for ws event")),
        timeoutMs,
      );
      waiters.push((e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
  };

  return { ws, next };
}

async function placeOrder(tenant: Tenant, qty = 1) {
  return SELF.fetch(
    `https://api.test/api/t/${tenant.outletId}/${tenant.qrToken}/orders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: [{ menuItemId: tenant.itemId, qty }] }),
    },
  );
}

describe("who may connect", () => {
  it("rejects an unauthenticated upgrade with 401", async () => {
    const a = await createTenant("Suriani");
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/ws`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(401);
  });

  it("answers 404 for another organisation's outlet", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${b.outletId}/ws`,
      { headers: { Upgrade: "websocket", ...auth(a) } },
    );
    // The same lie as everywhere else: you may not know it exists.
    expect(res.status).toBe(404);
  });
});

describe("snapshot then deltas", () => {
  it("sends the full floor on connect, then the order as it lands", async () => {
    const a = await createTenant("Suriani");
    const { next } = await connect(a);

    const snapshot = await next();
    expect(snapshot.type).toBe("snapshot");
    const tables = snapshot.tables as { label: string; session: unknown }[];
    expect(tables.map((t) => t.label)).toContain("Meja 05");
    expect(tables[0]!.session).toBeNull();

    const placed = await placeOrder(a, 2);
    expect(placed.status).toBe(201);

    const event = await next();
    expect(event.type).toBe("order.placed");
    expect(event.tableLabel).toBe("Meja 05");
    expect(event.totalSen).toBe(2 * a.itemPriceSen);
    const lines = event.lines as { qty: number; nameMs: string }[];
    expect(lines[0]!.qty).toBe(2);
  });

  it("keeps delivering after the Durable Object hibernates", async () => {
    const a = await createTenant("Suriani");
    const { next } = await connect(a);
    await next(); // snapshot

    // Evict the object. Hibernatable sockets survive this — that is the whole
    // point of the API, and the reason an idle till costs nothing.
    const stub = env.OUTLET.get(env.OUTLET.idFromName(a.doId));
    await evictDurableObject(stub);

    expect((await placeOrder(a)).status).toBe(201);
    const event = await next();
    expect(event.type).toBe("order.placed");
  });
});

describe("service lifecycle", () => {
  it("serve → bill request → close, each broadcast, table freed", async () => {
    const a = await createTenant("Suriani");
    const { next } = await connect(a);
    await next(); // snapshot

    await placeOrder(a, 2);
    const placed = await next();
    const orderId = placed.orderId as string;
    const sessionId = placed.sessionId as string;

    // Serve.
    const served = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/orders/${orderId}/served`,
      { method: "POST", headers: auth(a) },
    );
    expect(served.status).toBe(200);
    expect((await next()).type).toBe("order.served");

    // Customer asks for the bill.
    const bill = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${a.qrToken}/bill-request`,
      { method: "POST" },
    );
    expect(bill.status).toBe(200);
    const billEvent = await next();
    expect(billEvent.type).toBe("bill.requested");
    expect(billEvent.totalSen).toBe(2 * a.itemPriceSen);

    // The bill sheet shows the session.
    const sheet = (await (
      await SELF.fetch(
        `https://api.test/api/outlets/${a.outletId}/tables/${billEvent.tableId}/bill`,
        { headers: auth(a) },
      )
    ).json()) as { session: { status: string; totalSen: number } };
    expect(sheet.session.status).toBe("bill_requested");
    expect(sheet.session.totalSen).toBe(2 * a.itemPriceSen);

    // Close. Table frees, broadcast goes out.
    const closed = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/sessions/${sessionId}/close`,
      { method: "POST", headers: auth(a) },
    );
    expect(closed.status).toBe(200);
    expect((await next()).type).toBe("session.closed");

    // The next order at the same table opens a FRESH session — yesterday's
    // closed bill must never absorb today's food.
    const again = await placeOrder(a);
    expect(again.status).toBe(201);
    const fresh = (await again.json()) as { sessionId: string };
    expect(fresh.sessionId).not.toBe(sessionId);
  });

  it("throttles repeated waiter calls from one table", async () => {
    const a = await createTenant("Suriani");
    const { next } = await connect(a);
    await next(); // snapshot

    const call = () =>
      SELF.fetch(
        `https://api.test/api/t/${a.outletId}/${a.qrToken}/call-waiter`,
        { method: "POST" },
      );

    const first = (await (await call()).json()) as { coalesced: boolean };
    const second = (await (await call()).json()) as { coalesced: boolean };
    expect(first.coalesced).toBe(false);
    // The impatient second tap coalesces instead of ringing the till again.
    expect(second.coalesced).toBe(true);

    expect((await next()).type).toBe("waiter.called");
    // Exactly one event: the next thing on the wire must not be another call.
    await placeOrder(a);
    expect((await next()).type).toBe("order.placed");
  });
});

describe("86-ing", () => {
  it("flips availability, bumps menuVersion, blocks orders, tells phones", async () => {
    const a = await createTenant("Suriani");
    const { next } = await connect(a);
    await next(); // snapshot

    const statusBefore = (await (
      await SELF.fetch(
        `https://api.test/api/t/${a.outletId}/${a.qrToken}/status`,
      )
    ).json()) as { menuVersion: number };

    const flip = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/items/${a.itemId}/availability`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...auth(a) },
        body: JSON.stringify({ available: false }),
      },
    );
    expect(flip.status).toBe(200);

    const event = await next();
    expect(event.type).toBe("item.availability");
    expect(event.available).toBe(false);

    // The phone's next poll sees the version move and knows to refetch.
    const statusAfter = (await (
      await SELF.fetch(
        `https://api.test/api/t/${a.outletId}/${a.qrToken}/status`,
      )
    ).json()) as { menuVersion: number };
    expect(statusAfter.menuVersion).toBe(statusBefore.menuVersion + 1);

    // And the kitchen is protected server-side, not just visually.
    const refused = await placeOrder(a);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "unavailable",
    );
  });
});

describe("customer status poll", () => {
  it("walks the track as the till works", async () => {
    const a = await createTenant("Suriani");
    await placeOrder(a);

    const url = `https://api.test/api/t/${a.outletId}/${a.qrToken}/status`;
    const before = (await (await SELF.fetch(url)).json()) as {
      session: { orders: { id: string; status: string }[] };
    };
    expect(before.session.orders[0]!.status).toBe("placed");

    await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/orders/${before.session.orders[0]!.id}/served`,
      { method: "POST", headers: auth(a) },
    );

    const after = (await (await SELF.fetch(url)).json()) as {
      session: { orders: { status: string }[] };
    };
    expect(after.session.orders[0]!.status).toBe("served");
  });

  it("is token-gated like everything else on the customer path", async () => {
    const a = await createTenant("Suriani");
    const res = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/WRONGTOKEN/status`,
    );
    expect(res.status).toBe(404);
  });
});

describe("counter orders from the till", () => {
  it("places by tableId — the POS never handles QR secrets", async () => {
    const a = await createTenant("Suriani");
    const tables = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
        headers: auth(a),
      })
    ).json()) as { tables: { id: string }[] };

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(a) },
        body: JSON.stringify({
          tableId: tables.tables[0]!.id,
          lines: [{ menuItemId: a.itemId, qty: 1 }],
        }),
      },
    );
    expect(res.status).toBe(201);
    const placed = (await res.json()) as { totalSen: number };
    expect(placed.totalSen).toBe(a.itemPriceSen);
  });
});
