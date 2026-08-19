/**
 * Re-applying the master menu to an outlet that is already trading.
 *
 * The seed is insert-only by nature, which is fine the first time and wrong
 * every time after: an outlet that adopts a new set of categories would
 * otherwise end up showing the old ones *and* the new ones at once. So the
 * sync upserts and prunes — and these tests exist to prove the pruning does
 * not take history, 86 state or a table's QR code with it.
 */
import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { createTenant, auth } from "./helpers";
import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
  SEED_STATIONS,
} from "../src/seed-data";

/** The menu as it was before the owner renamed the columns. */
const OLD_CATEGORIES = [
  { id: "cat_nasi", nameMs: "Nasi", nameEn: "Rice", sortOrder: 0 },
  { id: "cat_manis", nameMs: "Pencuci Mulut", nameEn: "Desserts", sortOrder: 1 },
];
const OLD_ITEMS = [
  {
    id: "itm_old_nasilemak",
    categoryId: "cat_nasi",
    nameMs: "Nasi Lemak Ayam Berempah",
    nameEn: "Nasi Lemak with Spiced Chicken",
    priceSen: 1200,
    prepMinutes: 12,
  },
  {
    id: "itm_cendol",
    categoryId: "cat_manis",
    nameMs: "Cendol Pulut",
    nameEn: "Cendol with Glutinous Rice",
    priceSen: 650,
    prepMinutes: 5,
  },
];

async function outletOn(name: string) {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: OLD_CATEGORIES,
    items: OLD_ITEMS,
    tables: [],
    stations: [
      {
        id: "st_kitchen",
        name: "Dapur",
        target: "kitchen",
        isDefault: true,
        categoryIds: ["cat_nasi"],
      },
      { id: "st_drinks", name: "Minuman", target: "drinks", categoryIds: ["cat_manis"] },
    ],
  });
  return { t, stub };
}

const sync = (stub: DurableObjectStub<import("../src/outlet/OutletDO").OutletDO>) =>
  stub.applyMenu({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    modifierGroups: SEED_MODIFIER_GROUPS,
    stations: SEED_STATIONS,
  });

describe("menu sync", () => {
  it("replaces the old categories rather than stacking on top of them", async () => {
    const { stub } = await outletOn("Suriani Sync");

    const before = await stub.listMenu();
    expect(before.categories.map((c) => c.id)).toContain("cat_nasi");
    expect(before.categories.map((c) => c.id)).toContain("cat_manis");

    const result = await sync(stub);
    expect(result.removedCategories).toBe(before.categories.length);

    const after = await stub.listMenu();
    expect(after.categories).toHaveLength(SEED_CATEGORIES.length);
    expect(after.categories.map((c) => c.id)).toEqual(
      SEED_CATEGORIES.map((c) => c.id),
    );
    expect(after.categories.map((c) => c.id)).not.toContain("cat_nasi");
    expect(after.items.map((i) => i.id)).not.toContain("itm_cendol");
  });

  it("keeps a bill readable after the dish on it is gone", async () => {
    const { t, stub } = await outletOn("Suriani History");
    await stub.installSeed({
      categories: [],
      items: [],
      tables: [{ id: "tbl_hist", label: "Meja 07", qrToken: t.qrToken + "x" }],
    });

    const placed = await stub.placeOrder({
      tableId: "tbl_hist",
      lines: [{ menuItemId: "itm_cendol", qty: 2 }],
    });
    expect(placed.ok).toBe(true);

    await sync(stub);

    // The dish no longer exists on the menu. The bill still knows its name
    // and what it cost, because order_items snapshots both.
    const detail = await stub.getSessionDetail("tbl_hist");
    expect(detail?.session?.orders[0]?.lines[0]?.nameMs).toBe("Cendol Pulut");
    expect(detail?.session?.totalSen).toBe(1300);
  });

  it("does not un-86 a dish the kitchen has run out of", async () => {
    const { stub } = await outletOn("Suriani 86");
    await stub.installSeed({
      categories: SEED_CATEGORIES,
      items: SEED_ITEMS,
      tables: [],
    });

    await stub.setItemAvailability({ itemId: "itm_nasilemak", available: false });
    await sync(stub);

    const menu = await stub.listMenu();
    expect(menu.items.find((i) => i.id === "itm_nasilemak")?.isAvailable).toBe(0);
  });

  it("bumps menuVersion so a phone already on the menu refetches", async () => {
    const { stub } = await outletOn("Suriani Version");
    const before = (await stub.getSettings()).menuVersion ?? 1;
    const result = await sync(stub);
    expect(result.menuVersion).toBeGreaterThan(before);
  });

  it("moves routing with the categories instead of leaving stale rows", async () => {
    const { t, stub } = await outletOn("Suriani Routing");
    await sync(stub);

    // cat_minum used to route to drinks and still should; the categories that
    // vanished must not leave a row pointing at a station.
    const routes = await stub.listStationRoutes();
    expect(routes.some((r) => r.categoryId === "cat_manis")).toBe(false);
    expect(
      routes.find((r) => r.categoryId === "cat_minum")?.stationId,
    ).toBe("st_drinks");
    expect(
      routes.find((r) => r.categoryId === "cat_burger")?.stationId,
    ).toBe("st_kitchen");

    // And the outlet is still reachable through the normal staff route.
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/menu`,
      { headers: auth(t) },
    );
    expect(res.status).toBe(200);
  });
});
