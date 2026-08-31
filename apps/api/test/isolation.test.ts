/**
 * THE BLOCKING GATE.
 *
 * One restaurant seeing another restaurant's sales is the failure that ends a
 * POS business. This file exists to make that impossible to ship, and it must
 * never be skipped, quarantined, or marked flaky.
 *
 * Every test builds two genuinely independent tenants and then tries, from
 * several angles, to make one see the other.
 */
import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { createTenant, auth, type Tenant } from "./helpers";
import { createSession, verifySession } from "../src/auth/session";
import { ulid } from "../src/lib/ids";

async function placeOrder(tenant: Tenant, clientUlid?: string) {
  return SELF.fetch(
    `https://api.test/api/t/${tenant.outletId}/${tenant.qrToken}/orders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: [{ menuItemId: tenant.itemId, qty: 2 }],
        clientUlid,
      }),
    },
  );
}

describe("cross-tenant isolation", () => {
  it("answers 404 — not 403 — when reading another org's outlet", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);

    for (const path of ["orders", "menu", "tables"]) {
      const res = await SELF.fetch(
        `https://api.test/api/outlets/${b.outletId}/${path}`,
        { headers: auth(a) },
      );
      // 403 would confirm the outlet exists, letting an attacker enumerate
      // every restaurant on the platform one id at a time.
      expect(res.status, `GET ${path} across tenants`).toBe(404);
    }
  });

  it("never lists another org's outlets", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);

    const res = await SELF.fetch("https://api.test/api/outlets", {
      headers: auth(a),
    });
    const body = await res.json<{ outlets: { id: string }[] }>();
    const ids = body.outlets.map((o) => o.id);

    expect(ids).toContain(a.outletId);
    expect(ids).not.toContain(b.outletId);
  });

  it("keeps orders in the outlet they were placed in", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);

    expect((await placeOrder(a)).status).toBe(201);
    expect((await placeOrder(b)).status).toBe(201);

    const aOrders = await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/orders`, {
        headers: auth(a),
      })
    ).json<{ orders: { id: string; totalSen: number }[] }>();

    const bOrders = await (
      await SELF.fetch(`https://api.test/api/outlets/${b.outletId}/orders`, {
        headers: auth(b),
      })
    ).json<{ orders: { id: string }[] }>();

    expect(aOrders.orders).toHaveLength(1);
    expect(bOrders.orders).toHaveLength(1);
    expect(aOrders.orders[0]!.id).not.toBe(bOrders.orders[0]!.id);
    // 2 × RM12.00
    expect(aOrders.orders[0]!.totalSen).toBe(2400);
  });

  it("rejects a session whose orgId has been edited", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);

    // Forge a token claiming A's user belongs to B's organisation.
    const [body] = a.token.split(".") as [string];
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(body.replace(/-/g, "+").replace(/_/g, "/")),
          (ch) => ch.charCodeAt(0),
        ),
      ),
    ) as { orgId: string };
    decoded.orgId = b.orgId;

    const tamperedBody = btoa(JSON.stringify(decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${tamperedBody}.${a.token.split(".")[1]}`;

    expect(await verifySession(forged, env.SESSION_SECRET)).toBeNull();

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${b.outletId}/orders`,
      { headers: { Authorization: `Bearer ${forged}` } },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a session signed with the wrong secret", async () => {
    const a = await createTenant("Suriani");
    const forged = await createSession(
      { userId: a.userId, orgId: a.orgId, role: "owner" },
      "not-the-real-secret",
    );

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/orders`,
      { headers: { Authorization: `Bearer ${forged}` } },
    );
    expect(res.status).toBe(401);
  });

  it("gives a guessed outlet id nothing to reach", async () => {
    const a = await createTenant("Suriani");

    for (const guess of ["out_000000", a.outletId + "x", "../admin", "1"]) {
      const res = await SELF.fetch(
        `https://api.test/api/outlets/${encodeURIComponent(guess)}/orders`,
        { headers: auth(a) },
      );
      expect(res.status, `guess ${guess}`).toBe(404);
    }
  });
});

describe("customer QR path", () => {
  it("will not accept another outlet's table token", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);

    // B's token is real, but not at A's outlet.
    const res = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${b.qrToken}`,
    );
    expect(res.status).toBe(404);

    const order = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${b.qrToken}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: [{ menuItemId: a.itemId, qty: 1 }] }),
      },
    );
    expect(order.status).toBe(404);
  });

  it("rejects a guessed table token", async () => {
    const a = await createTenant("Suriani");
    const res = await SELF.fetch(`https://api.test/api/t/${a.outletId}/MEJA05`);
    expect(res.status).toBe(404);
  });

  it("serves the menu for a valid token without any session", async () => {
    const a = await createTenant("Suriani");
    const res = await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${a.qrToken}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json<{
      table: { label: string };
      menu: { items: { id: string; priceSen: number }[] };
    }>();
    expect(body.table.label).toBe("Meja 05");
    expect(body.menu.items[0]!.priceSen).toBe(1200);
  });
});

describe("offline replay safety", () => {
  it("treats a repeated clientUlid as the same order", async () => {
    const a = await createTenant("Suriani");
    const key = ulid();

    const first = await placeOrder(a, key);
    const second = await placeOrder(a, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    const one = await first.json<{ orderId: string; duplicate: boolean }>();
    const two = await second.json<{ orderId: string; duplicate: boolean }>();

    expect(one.duplicate).toBe(false);
    expect(two.duplicate).toBe(true);
    expect(two.orderId).toBe(one.orderId);

    // The real assertion: a tablet replaying its op log after an outage must
    // not bill the customer twice.
    const orders = await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/orders`, {
        headers: auth(a),
      })
    ).json<{ orders: unknown[] }>();
    expect(orders.orders).toHaveLength(1);
  });
});
