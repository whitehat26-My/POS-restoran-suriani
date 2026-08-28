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
        menuItemId: "itm_min_tehtarik",
        qty: 2,
        modifierOptionIds: ["mo_tehtarik_bksais"],
      },
    ]);
    expect(res.status).toBe(201);

    const placed = (await res.json()) as { totalSen: number };
    // (250 + 50 surcharge) x 2
    expect(placed.totalSen).toBe(600);
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

    const teh = page.menu.items.find((i) => i.id === "itm_min_tehtarik");
    expect(teh?.modifierGroups).toHaveLength(1);
    expect(teh?.modifierGroups[0]!.nameMs).toBe("Panas, ais atau bungkus?");
    expect(teh?.modifierGroups[0]!.options.map((o) => o.id)).toEqual([
      "mo_tehtarik_panas",
      "mo_tehtarik_ais",
      "mo_tehtarik_bkspanas",
      "mo_tehtarik_bksais",
    ]);
  });

  it("enforces a required choice", async () => {
    const t = await withMenu("Suriani");

    // Every drink must say hot, iced or takeaway — that choice is what the
    // menu's RM 0.50 surcharge rides on, so it cannot be skipped.
    const missing = await order(t, [{ menuItemId: "itm_min_tehtarik", qty: 1 }]);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "option_required",
    );

    const chosen = await order(t, [
      { menuItemId: "itm_min_tehtarik", qty: 1, modifierOptionIds: ["mo_tehtarik_ais"] },
    ]);
    expect(chosen.status).toBe(201);
    // 250 + 50 for ais
    expect(((await chosen.json()) as { totalSen: number }).totalSen).toBe(300);
  });

  it("enforces the maximum", async () => {
    const t = await withMenu("Suriani");

    // Hot and iced at once. The group allows one, and the server is the thing
    // that says so — the UI only makes it hard, not impossible.
    const res = await order(t, [
      {
        menuItemId: "itm_min_tehtarik",
        qty: 1,
        modifierOptionIds: ["mo_tehtarik_panas", "mo_tehtarik_ais"],
      },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "too_many_options",
    );
  });

  it("refuses an option borrowed from another dish", async () => {
    const t = await withMenu("Suriani");

    // "Sup" belongs to Mee Kungfu. Attaching it to a teh tarik must fail —
    // otherwise a dish could borrow another's cheaper options.
    const res = await order(t, [
      {
        menuItemId: "itm_min_tehtarik",
        qty: 1,
        modifierOptionIds: ["mo_kungfu_sup"],
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
      { menuItemId: "itm_min_tehtarik", qty: 1, modifierOptionIds: ["mo_tehtarik_ais"] },
    ]);
    expect(placed.status).toBe(201);

    // The kedai raises the ais surcharge at 3pm.
    const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        "UPDATE modifier_options SET price_delta_sen = 200 WHERE id = 'mo_tehtarik_ais'",
      );
    });

    // This morning's bill must not move.
    const orders = (await (
      await SELF.fetch(`https://api.test/api/outlets/${t.outletId}/orders`, {
        headers: auth(t),
      })
    ).json()) as { orders: { totalSen: number }[] };
    expect(orders.orders[0]!.totalSen).toBe(300);

    // A new order pays the new price.
    const fresh = await order(t, [
      { menuItemId: "itm_min_tehtarik", qty: 1, modifierOptionIds: ["mo_tehtarik_ais"] },
    ]);
    expect(((await fresh.json()) as { totalSen: number }).totalSen).toBe(450);
  });
});

describe("the menu's RM 0.50 rule", () => {
  it("charges it once for an iced drink taken away, not twice", async () => {
    const t = await withMenu("Suriani");

    const res = await order(t, [
      {
        menuItemId: "itm_min_tehtarik",
        qty: 1,
        modifierOptionIds: ["mo_tehtarik_bksais"],
      },
    ]);
    expect(res.status).toBe(201);
    // RM 2.50 + one surcharge. Two independent +50 options would make this
    // RM 3.50, which is not what the owner charges.
    expect(((await res.json()) as { totalSen: number }).totalSen).toBe(300);
  });

  it("does not charge to chill something already cold", async () => {
    const t = await withMenu("Suriani");

    const dineIn = await order(t, [
      { menuItemId: "itm_min_airsmall", qty: 1, modifierOptionIds: ["mo_airsmall_sini"] },
    ]);
    expect(((await dineIn.json()) as { totalSen: number }).totalSen).toBe(150);

    const takeaway = await order(t, [
      { menuItemId: "itm_min_airsmall", qty: 1, modifierOptionIds: ["mo_airsmall_bungkus"] },
    ]);
    expect(((await takeaway.json()) as { totalSen: number }).totalSen).toBe(200);
  });

  it("is free to choose a noodle and free to choose sup", async () => {
    const t = await withMenu("Suriani");

    const res = await order(t, [
      {
        menuItemId: "itm_mee_kungfu",
        qty: 1,
        modifierOptionIds: ["mo_kungfu_kuetiau", "mo_kungfu_sup"],
      },
    ]);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { totalSen: number }).totalSen).toBe(1000);
  });

  it("will not let a noodle dish through without both choices", async () => {
    const t = await withMenu("Suriani");

    const res = await order(t, [
      { menuItemId: "itm_mee_kungfu", qty: 1, modifierOptionIds: ["mo_kungfu_kuetiau"] },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("option_required");
  });
});
