/**
 * Modifier options — resolved and priced by the server, chosen by id.
 */
import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";

import { createTenant, auth, type Tenant } from "./helpers";
import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
} from "../src/seed-data";

/** Give a tenant the full seeded menu, options included. */
async function withMenu(name: string): Promise<Tenant> {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    tables: [],
    modifierGroups: SEED_MODIFIER_GROUPS,
  });
  return t;
}

async function order(t: Tenant, lines: unknown[]) {
  return SELF.fetch(`https://api.test/api/t/${t.outletId}/${t.qrToken}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  });
}

describe("modifier options", () => {
  it("prices a valid selection from its own database", async () => {
    const t = await withMenu("Suriani");

    const res = await order(t, [
      {
        menuItemId: "itm_nasilemak",
        qty: 2,
        modifierOptionIds: ["mo_nl_telur", "mo_nl_ayam"],
      },
    ]);
    expect(res.status).toBe(201);

    const placed = (await res.json()) as { totalSen: number };
    // (1200 + 150 telur + 450 ayam) × 2
    expect(placed.totalSen).toBe(3600);
  });

  it("appears in the customer menu payload", async () => {
    const t = await withMenu("Suriani");
    const page = (await (
      await SELF.fetch(`https://api.test/api/t/${t.outletId}/${t.qrToken}`)
    ).json()) as {
      menu: {
        items: {
          id: string;
          modifierGroups: { nameMs: string; options: { id: string }[] }[];
        }[];
      };
    };

    const teh = page.menu.items.find((i) => i.id === "itm_tehtarik");
    expect(teh?.modifierGroups).toHaveLength(1);
    expect(teh?.modifierGroups[0]!.nameMs).toBe("Panas atau ais?");
    expect(teh?.modifierGroups[0]!.options.map((o) => o.id)).toEqual([
      "mo_teh_panas",
      "mo_teh_ais",
    ]);
  });

  it("enforces a required choice", async () => {
    const t = await withMenu("Suriani");

    // Teh Tarik's temperature group is min_select 1: hot or iced, you must say.
    const missing = await order(t, [{ menuItemId: "itm_tehtarik", qty: 1 }]);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "option_required",
    );

    const chosen = await order(t, [
      { menuItemId: "itm_tehtarik", qty: 1, modifierOptionIds: ["mo_teh_ais"] },
    ]);
    expect(chosen.status).toBe(201);
    // 300 + 50 for ais
    expect(((await chosen.json()) as { totalSen: number }).totalSen).toBe(350);
  });

  it("enforces the maximum", async () => {
    const t = await withMenu("Suriani");

    // Extras group allows two. Sending three (double egg + chicken) is over.
    const res = await order(t, [
      {
        menuItemId: "itm_nasilemak",
        qty: 1,
        modifierOptionIds: ["mo_nl_telur", "mo_nl_telur", "mo_nl_ayam"],
      },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "too_many_options",
    );
  });

  it("refuses an option borrowed from another dish", async () => {
    const t = await withMenu("Suriani");

    // "Tambah ayam" belongs to nasi lemak. Attaching it to mee goreng must
    // fail — otherwise a dish could borrow another's cheaper extras.
    const res = await order(t, [
      {
        menuItemId: "itm_meegoreng",
        qty: 1,
        modifierOptionIds: ["mo_nl_ayam"],
      },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unknown_option",
    );
  });

  it("snapshots the option price at order time", async () => {
    const t = await withMenu("Suriani");

    const placed = await order(t, [
      { menuItemId: "itm_tehtarik", qty: 1, modifierOptionIds: ["mo_teh_ais"] },
    ]);
    expect(placed.status).toBe(201);

    // The kedai raises the ais surcharge at 3pm.
    const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE modifier_options SET price_delta_sen = 200 WHERE id = 'mo_teh_ais'",
      );
    });

    // This morning's bill must not move.
    const orders = (await (
      await SELF.fetch(`https://api.test/api/outlets/${t.outletId}/orders`, {
        headers: auth(t),
      })
    ).json()) as { orders: { totalSen: number }[] };
    expect(orders.orders[0]!.totalSen).toBe(350);

    // A new order pays the new price.
    const fresh = await order(t, [
      { menuItemId: "itm_tehtarik", qty: 1, modifierOptionIds: ["mo_teh_ais"] },
    ]);
    expect(((await fresh.json()) as { totalSen: number }).totalSen).toBe(500);
  });
});
