/**
 * Phase 1's gate, demonstrated end to end:
 * two outlets exist, and their data is provably separate.
 *
 * This exercises the real onboarding path rather than a test-only shortcut, so
 * what CI proves is what actually happens when a restaurant is signed up.
 */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

import { SEED_CATEGORIES, SEED_ITEMS } from "../src/seed-data";

const SEED_TOKEN = "test-seed-token";

interface SeedResponse {
  created: boolean;
  orgId: string;
  outlets: { id: string; name: string; sampleQrPath?: string }[];
}

async function seed(phone: string, token = SEED_TOKEN) {
  return SELF.fetch("https://api.test/api/admin/seed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      orgName: "Restoran Suriani",
      ownerPhone: phone,
      ownerPin: "246810",
    }),
  });
}

describe("onboarding", () => {
  it("refuses without the admin token, and says 404 rather than 401", async () => {
    const noAuth = await SELF.fetch("https://api.test/api/admin/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPhone: "+60100000001", ownerPin: "246810" }),
    });
    // 401 would advertise that an onboarding endpoint exists here at all.
    expect(noAuth.status).toBe(404);

    const wrongToken = await seed("+60100000002", "guessed-token");
    expect(wrongToken.status).toBe(404);
  });

  it("creates both Suriani branches with a working QR", async () => {
    const res = await seed("+60100000010");
    expect(res.status).toBe(201);

    const body = (await res.json()) as SeedResponse;
    expect(body.created).toBe(true);
    expect(body.outlets.map((o) => o.name)).toEqual([
      "Suriani Kampung Baru",
      "Suriani Bangi",
    ]);

    // The QR printed for Meja 01 must actually open a menu.
    const menu = await SELF.fetch(
      // sampleQrPath is the printed human URL (/t/...); its data lives at /api/t/...
      `https://api.test/api${body.outlets[0]!.sampleQrPath}`,
    );
    expect(menu.status).toBe(200);

    const page = (await menu.json()) as {
      table: { label: string };
      menu: {
        categories: { id: string; nameMs: string }[];
        items: { id: string; nameMs: string; priceSen: number }[];
      };
    };
    expect(page.table.label).toBe("Meja 01");
    // Counted from the seed rather than hardcoded: the menu is the one thing
    // here that is meant to change, and a magic number turns every menu edit
    // into a failing test that says nothing useful.
    expect(page.menu.items).toHaveLength(SEED_ITEMS.length);
    expect(page.menu.categories).toHaveLength(SEED_CATEGORIES.length);
    expect(page.menu.categories.map((c) => c.nameMs)).toEqual(
      SEED_CATEGORIES.map((c) => c.nameMs),
    );

    const nasiLemak = page.menu.items.find((i) => i.id === "itm_nl_biasa");
    expect(nasiLemak?.nameMs).toBe("Nasi Lemak Biasa");
    expect(nasiLemak?.priceSen).toBe(600);
  });

  it("is idempotent — re-running does not create a second Suriani", async () => {
    const phone = "+60100000020";
    const first = (await (await seed(phone)).json()) as SeedResponse;
    const second = (await (await seed(phone)).json()) as SeedResponse;

    expect(second.created).toBe(false);
    expect(second.orgId).toBe(first.orgId);
    expect(second.outlets).toHaveLength(2);
  });

  it("keeps the two branches' trading data separate", async () => {
    const body = (await (await seed("+60100000030")).json()) as SeedResponse;
    const [kampungBaru, bangi] = body.outlets as [
      SeedResponse["outlets"][number],
      SeedResponse["outlets"][number],
    ];

    // Order at Kampung Baru only.
    const placed = await SELF.fetch(
      `https://api.test/api${kampungBaru.sampleQrPath}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: [{ menuItemId: "itm_nl_biasa", qty: 2 }],
        }),
      },
    );
    expect(placed.status).toBe(201);

    // Sign in as the owner, who legitimately owns both branches.
    const login = await SELF.fetch("https://api.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+60100000030", pin: "246810" }),
    });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };

    const kbOrders = (await (
      await SELF.fetch(
        `https://api.test/api/outlets/${kampungBaru.id}/orders`,
        { headers },
      )
    ).json()) as { orders: { totalSen: number }[] };

    const bangiOrders = (await (
      await SELF.fetch(`https://api.test/api/outlets/${bangi.id}/orders`, {
        headers,
      })
    ).json()) as { orders: unknown[] };

    expect(kbOrders.orders).toHaveLength(1);
    expect(kbOrders.orders[0]!.totalSen).toBe(1200);
    // Same owner, same organisation — but the other branch is a different
    // database and knows nothing about that order.
    expect(bangiOrders.orders).toHaveLength(0);
  });

  it("rejects a wrong PIN without revealing whether the phone exists", async () => {
    await seed("+60100000040");

    const wrongPin = await SELF.fetch("https://api.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+60100000040", pin: "999999" }),
    });
    const unknownPhone = await SELF.fetch("https://api.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+60199999999", pin: "246810" }),
    });

    expect(wrongPin.status).toBe(401);
    expect(unknownPhone.status).toBe(401);
    expect(await wrongPin.text()).toBe(await unknownPhone.text());
  });
});
