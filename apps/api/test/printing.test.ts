/**
 * The print pipeline.
 *
 * A docket that never prints is a table that never gets its food, so the
 * interesting tests here are the failure ones: a dead agent, a jammed printer,
 * a retry that must not double-print.
 */
import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";

import { createTenant, auth, type Tenant } from "./helpers";
import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
  SEED_STATIONS,
} from "../src/seed-data";

const decode = (b64: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
  );

/** A tenant with the full menu and all three print stations routed. */
async function withStations(name: string): Promise<Tenant> {
  const t = await createTenant(name);
  const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));
  await stub.installSeed({
    categories: SEED_CATEGORIES,
    items: SEED_ITEMS,
    tables: [],
    modifierGroups: SEED_MODIFIER_GROUPS,
    stations: SEED_STATIONS,
    outletName: `${name} Cawangan`,
  });
  return t;
}

async function registerAgent(t: Tenant): Promise<string> {
  const res = await SELF.fetch(
    `https://api.test/api/outlets/${t.outletId}/agents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(t) },
      body: JSON.stringify({ name: "Kitchen Pi" }),
    },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

const agentAuth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function order(t: Tenant, lines: unknown[]) {
  return SELF.fetch(`https://api.test/api/t/${t.outletId}/${t.qrToken}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  });
}

async function claim(t: Tenant, token: string) {
  const res = await SELF.fetch("https://api.test/api/agent/jobs", {
    headers: agentAuth(token),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as {
    jobs: { id: string; target: string; escposBase64: string }[];
  }).jobs;
}

describe("station routing", () => {
  it("splits one order into one docket per station", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);

    // Nasi (kitchen) + teh tarik (drinks) in a single order.
    expect(
      (
        await order(t, [
          { menuItemId: "itm_nasilemak", qty: 1 },
          {
            menuItemId: "itm_tehtarik",
            qty: 2,
            modifierOptionIds: ["mo_teh_ais"],
          },
        ])
      ).status,
    ).toBe(201);

    const jobs = await claim(t, token);
    expect(jobs).toHaveLength(2);

    const byTarget = new Map(jobs.map((j) => [j.target, decode(j.escposBase64)]));
    const kitchen = byTarget.get("kitchen")!;
    const drinks = byTarget.get("drinks")!;

    // Each slip carries only its own lines — the cook must not be handed
    // drinks, and the drinks counter must not be handed nasi.
    expect(kitchen).toContain("NASI LEMAK");
    expect(kitchen).not.toContain("TEH TARIK");
    expect(drinks).toContain("TEH TARIK");
    expect(drinks).not.toContain("NASI LEMAK");
  });

  it("prints an unrouted category at the default station rather than nowhere", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    const stub = env.OUTLET.get(env.OUTLET.idFromName(t.doId));

    // A category added later, before anyone routed it.
    await stub.installSeed({
      categories: [
        { id: "cat_baru", nameMs: "Baru", nameEn: "New", sortOrder: 9 },
      ],
      items: [
        {
          id: "itm_baru",
          categoryId: "cat_baru",
          nameMs: "Menu Baru",
          nameEn: "New Dish",
          priceSen: 800,
        },
      ],
      tables: [],
    });

    await order(t, [{ menuItemId: "itm_baru", qty: 1 }]);
    const jobs = await claim(t, token);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.target).toBe("kitchen");
    expect(decode(jobs[0]!.escposBase64)).toContain("MENU BARU");
  });
});

describe("the docket the cook actually reads", () => {
  it("carries modifiers and the kitchen note", async () => {
    // Phase 1 stored {qty, name} only, so "kurang pedas" never reached the
    // kitchen. This is the regression guard for that defect.
    const t = await withStations("Suriani");
    const token = await registerAgent(t);

    await order(t, [
      {
        menuItemId: "itm_nasilemak",
        qty: 2,
        modifierOptionIds: ["mo_nl_telur"],
        notes: "kurang pedas",
      },
    ]);

    const [job] = await claim(t, token);
    const slip = decode(job!.escposBase64);
    expect(slip).toContain("2x NASI LEMAK");
    expect(slip).toContain("Tambah telur");
    expect(slip).toContain("kurang pedas");
    // And still no prices on a kitchen slip.
    expect(slip).not.toContain("RM");
  });
});

describe("leases", () => {
  it("returns an unacked job after its lease expires", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_nasilemak", qty: 1 }]);

    const first = await claim(t, token);
    expect(first).toHaveLength(1);

    // A second agent must not steal work that is still leased.
    expect(await claim(t, token)).toHaveLength(0);

    // The agent dies mid-print: no ack, lease expires.
    await runInDurableObject(
      env.OUTLET.get(env.OUTLET.idFromName(t.doId)),
      async (_i, state) => {
        state.storage.sql.exec(
          "UPDATE print_jobs SET lease_until = 1 WHERE status = 'claimed'",
        );
      },
    );

    // The docket comes back rather than being lost in silence.
    const again = await claim(t, token);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first[0]!.id);
  });
});

describe("acks", () => {
  it("marks printed and stops offering the job", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_nasilemak", qty: 1 }]);

    const [job] = await claim(t, token);
    const ack = await SELF.fetch(
      `https://api.test/api/agent/jobs/${job!.id}/ack`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuth(token) },
        body: JSON.stringify({ ok: true, transport: "lan" }),
      },
    );
    expect(((await ack.json()) as { status: string }).status).toBe("printed");
    expect(await claim(t, token)).toHaveLength(0);
  });

  it("treats a repeated ack as a no-op, not a resurrection", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_nasilemak", qty: 1 }]);
    const [job] = await claim(t, token);

    const send = () =>
      SELF.fetch(`https://api.test/api/agent/jobs/${job!.id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuth(token) },
        body: JSON.stringify({ ok: true, transport: "lan" }),
      });

    await send();
    const second = await send();
    // A retrying agent must not reopen a printed docket or inflate attempts.
    expect(((await second.json()) as { status: string }).status).toBe("printed");

    const health = (await (
      await SELF.fetch(
        `https://api.test/api/outlets/${t.outletId}/print/health`,
        { headers: auth(t) },
      )
    ).json()) as { queued: number; failed: number };
    expect(health.queued).toBe(0);
    expect(health.failed).toBe(0);
  });
});

describe("failure", () => {
  it("backs off, then gives up loudly", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_nasilemak", qty: 1 }]);
    const [job] = await claim(t, token);

    const fail = () =>
      SELF.fetch(`https://api.test/api/agent/jobs/${job!.id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuth(token) },
        body: JSON.stringify({ ok: false, error: "no paper" }),
      });

    for (let i = 0; i < 4; i++) {
      const res = await fail();
      expect(((await res.json()) as { status: string }).status).toBe("queued");
    }
    const last = await fail();
    expect(((await last.json()) as { status: string }).status).toBe("failed");

    const health = (await (
      await SELF.fetch(
        `https://api.test/api/outlets/${t.outletId}/print/health`,
        { headers: auth(t) },
      )
    ).json()) as {
      failed: number;
      recent: { lastError: string | null; tableLabel: string }[];
    };
    expect(health.failed).toBe(1);
    // The till must be able to name the table and the reason.
    expect(health.recent[0]!.lastError).toBe("no paper");
    expect(health.recent[0]!.tableLabel).toBe("Meja 05");
  });

  it("reports a stalled queue when the agent is simply gone", async () => {
    // The failure retries cannot catch: nothing is failing, jobs just sit.
    const t = await withStations("Suriani");
    await order(t, [{ menuItemId: "itm_nasilemak", qty: 1 }]);

    await runInDurableObject(
      env.OUTLET.get(env.OUTLET.idFromName(t.doId)),
      async (_i, state) => {
        state.storage.sql.exec(
          "UPDATE print_jobs SET first_queued_at = ?",
          Date.now() - 120_000,
        );
      },
    );

    const health = (await (
      await SELF.fetch(
        `https://api.test/api/outlets/${t.outletId}/print/health`,
        { headers: auth(t) },
      )
    ).json()) as { stalled: boolean };
    expect(health.stalled).toBe(true);
  });
});

describe("reprint", () => {
  it("re-queues from the stored snapshot and marks the slip", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_nasilemak", qty: 1 }]);
    const [job] = await claim(t, token);

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/print/jobs/${job!.id}/reprint`,
      { method: "POST", headers: auth(t) },
    );
    expect(res.status).toBe(200);

    const again = await claim(t, token);
    expect(again).toHaveLength(1);
    const slip = decode(again[0]!.escposBase64);
    // Marked, so nobody cooks it twice.
    expect(slip).toContain("CETAK SEMULA");
    expect(slip).toContain("NASI LEMAK");
  });
});

describe("agent credentials", () => {
  it("refuses an unauthenticated or forged token", async () => {
    const t = await withStations("Suriani");
    await registerAgent(t);

    const attempts: Record<string, string>[] = [
      {},
      { Authorization: "Bearer nonsense" },
      { Authorization: "Bearer dev_fake.secret" },
    ];
    for (const headers of attempts) {
      const res = await SELF.fetch("https://api.test/api/agent/jobs", {
        headers,
      });
      expect(res.status).toBe(401);
    }
  });

  it("scopes an agent to its own outlet's queue", async () => {
    const [a, b] = await Promise.all([
      withStations("Suriani"),
      withStations("Rival"),
    ]);
    const tokenA = await registerAgent(a);

    // B's kitchen is busy; A's agent must see none of it.
    await order(b, [{ menuItemId: "itm_nasilemak", qty: 1 }]);
    expect(await claim(a, tokenA)).toHaveLength(0);

    await order(a, [{ menuItemId: "itm_nasilemak", qty: 1 }]);
    expect(await claim(a, tokenA)).toHaveLength(1);
  });

  it("cannot reach staff routes", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/orders`,
      { headers: agentAuth(token) },
    );
    // An agent token is not a session; the staff middleware rejects it.
    expect(res.status).toBe(401);
  });

  it("is only issued to owners and managers", async () => {
    const t = await withStations("Suriani");
    const { authAs } = await import("./helpers");
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/agents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authAs(t, "cashier")),
        },
        body: JSON.stringify({ name: "sneaky" }),
      },
    );
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ *
 * The counter bill
 * ------------------------------------------------------------------ */

describe("counter receipt", () => {
  it("prints a bill, not a kitchen docket, at the counter station", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);

    await order(t, [
      { menuItemId: "itm_nasilemak", qty: 2, modifierOptionIds: ["mo_nl_telur"] },
    ]);
    // Drain the kitchen dockets so what is left is unambiguous.
    for (const job of await claim(t, token)) {
      await SELF.fetch(`https://api.test/api/agent/jobs/${job.id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuth(token) },
        body: JSON.stringify({ ok: true, transport: "tcp" }),
      });
    }

    const floor = (await (
      await SELF.fetch(`https://api.test/api/outlets/${t.outletId}/floor`, {
        headers: auth(t),
      })
    ).json()) as { tables: { id: string; session: { id: string } | null }[] };
    const sessionId = floor.tables.find((tb) => tb.session)!.session!.id;

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/sessions/${sessionId}/receipt`,
      { method: "POST", headers: auth(t) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, totalSen: 2700, itemCount: 2 });

    const jobs = await claim(t, token);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.target).toBe("counter");

    const slip = decode(jobs[0]!.escposBase64);
    expect(slip).toContain("BIL");
    expect(slip).toContain("Nasi Lemak Ayam Berempah");
    expect(slip).toContain("Tambah telur");
    expect(slip).toContain("27.00");
    expect(slip).toContain("Sila jelaskan di kaunter");
    // Nothing has been paid, so nothing claims to have been.
    expect(slip).not.toContain("TUNAI");
  });

  it("carries the outlet's own name, never a default", async () => {
    const t = await withStations("Warung Bangi");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_kopi", qty: 1 }]);

    const jobs = await claim(t, token);
    const slip = decode(jobs[0]!.escposBase64);
    expect(slip).toContain("Warung Bangi Cawangan");
    expect(slip).not.toContain("Restoran Suriani");
  });

  it("reprints a bill as a bill, stamped as a copy", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);
    await order(t, [{ menuItemId: "itm_roti", qty: 1 }]);
    for (const job of await claim(t, token)) {
      await SELF.fetch(`https://api.test/api/agent/jobs/${job.id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuth(token) },
        body: JSON.stringify({ ok: true, transport: "tcp" }),
      });
    }

    const floor = (await (
      await SELF.fetch(`https://api.test/api/outlets/${t.outletId}/floor`, {
        headers: auth(t),
      })
    ).json()) as { tables: { session: { id: string } | null }[] };
    const sessionId = floor.tables.find((tb) => tb.session)!.session!.id;

    await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/sessions/${sessionId}/receipt`,
      { method: "POST", headers: auth(t) },
    );
    const [billJob] = await claim(t, token);
    await SELF.fetch(`https://api.test/api/agent/jobs/${billJob!.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...agentAuth(token) },
      body: JSON.stringify({ ok: true, transport: "tcp" }),
    });

    await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/print/jobs/${billJob!.id}/reprint`,
      { method: "POST", headers: auth(t) },
    );

    const [copy] = await claim(t, token);
    const slip = decode(copy!.escposBase64);
    expect(slip).toContain("SALINAN");
    expect(slip).toContain("BIL");
    // A reprint must not turn a receipt back into something the kitchen cooks.
    expect(slip).not.toContain("DAPUR");
  });

  it("answers 404 for a session in another outlet", async () => {
    const a = await withStations("Suriani A");
    const b = await withStations("Suriani B");
    await order(b, [{ menuItemId: "itm_kopi", qty: 1 }]);

    const floor = (await (
      await SELF.fetch(`https://api.test/api/outlets/${b.outletId}/floor`, {
        headers: auth(b),
      })
    ).json()) as { tables: { session: { id: string } | null }[] };
    const sessionId = floor.tables.find((tb) => tb.session)!.session!.id;

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/sessions/${sessionId}/receipt`,
      { method: "POST", headers: auth(a) },
    );
    expect(res.status).toBe(404);
  });
});

describe("a request on a dish with no options", () => {
  it("reaches the cook", async () => {
    const t = await withStations("Suriani");
    const token = await registerAgent(t);

    // Kopi O Ais has no modifier groups at all. Half the menu is like this,
    // and a note left on one of those dishes must not fall on the floor.
    await order(t, [
      { menuItemId: "itm_kopi", qty: 1, notes: "kurang manis, bungkus" },
    ]);

    const jobs = await claim(t, token);
    expect(jobs).toHaveLength(1);
    expect(decode(jobs[0]!.escposBase64)).toContain("kurang manis, bungkus");
  });
});
