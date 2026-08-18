/**
 * Configurable tables.
 *
 * The heaviest test here is the migration upgrade. Until now the migration
 * runner had only ever built a schema from nothing; v2 is the first time it
 * touches outlets that already hold live orders. If it is wrong, this is where
 * it shows — and the cost of it being wrong in production is a restaurant's
 * trading history.
 */
import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";

import { createTenant, auth, authAs } from "./helpers";
import { MIGRATIONS, TARGET_VERSION, runMigrations } from "../src/outlet/migrations";
import { doId } from "../src/lib/ids";

describe("migration v2 upgrades an outlet that already has data", () => {
  it("keeps every existing row and adds the new columns", async () => {
    const stub = env.OUTLET.get(env.OUTLET.idFromName(doId()));
    await stub.schemaVersion(); // construct

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      // Rewind this database to look like a v1 outlet that has been trading.
      const existing = [
        ...sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        ),
      ].map((r) => r.name);
      for (const name of existing) sql.exec(`DROP TABLE IF EXISTS "${name}"`);

      sql.exec(
        `CREATE TABLE _schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)`,
      );
      for (const statement of MIGRATIONS[0]!.statements) sql.exec(statement);
      sql.exec("INSERT INTO _schema_version (version, applied_at) VALUES (1, 0)");

      // Real trading data, of the kind a live branch would hold.
      sql.exec(
        "INSERT INTO tables (id, label, qr_token, status) VALUES ('t1', 'Meja 05', 'tok_abc', 'eating')",
      );
      sql.exec(
        "INSERT INTO table_sessions (id, table_id, opened_at, status) VALUES ('s1', 't1', 1000, 'open')",
      );
      sql.exec(
        `INSERT INTO orders (id, session_id, placed_at, source, client_ulid, status)
         VALUES ('o1', 's1', 1000, 'qr', 'ulid_1', 'placed')`,
      );
      sql.exec(
        `INSERT INTO order_items (id, order_id, menu_item_id, name_ms, name_en, qty, unit_price_sen)
         VALUES ('oi1', 'o1', 'm1', 'Nasi Lemak', 'Nasi Lemak', 2, 1200)`,
      );

      // Now upgrade.
      const version = runMigrations(sql);
      // Always the latest — this test rewinds to v1 and must land wherever
      // the runner currently tops out, not at a hardcoded number.
      expect(version).toBe(TARGET_VERSION);

      // Nothing was lost.
      const tables = [
        ...sql.exec<{ id: string; label: string; archived_at: number | null }>(
          "SELECT id, label, archived_at FROM tables",
        ),
      ];
      expect(tables).toHaveLength(1);
      expect(tables[0]!.label).toBe("Meja 05");
      // New column exists and defaults sensibly for pre-existing rows.
      expect(tables[0]!.archived_at).toBeNull();

      const items = [
        ...sql.exec<{ unit_price_sen: number }>(
          "SELECT unit_price_sen FROM order_items",
        ),
      ];
      expect(items).toHaveLength(1);
      expect(items[0]!.unit_price_sen).toBe(1200);

      // And the v2 structures are present.
      const names = [
        ...sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table'",
        ),
      ].map((r) => r.name);
      expect(names).toContain("zones");
      expect(names).toContain("settings");

      // Re-running is still a no-op.
      expect(runMigrations(sql)).toBe(TARGET_VERSION);
    });
  });
});

describe("who may change the floor plan", () => {
  it("lets an owner and a manager through, and refuses a cashier with 403", async () => {
    const a = await createTenant("Suriani");
    const url = `https://api.test/api/outlets/${a.outletId}/tables`;
    const body = JSON.stringify({ label: "Meja 99" });
    const json = { "Content-Type": "application/json" };

    const cashier = await SELF.fetch(url, {
      method: "POST",
      headers: { ...json, ...(await authAs(a, "cashier")) },
      body,
    });
    // 403, not 404: the cashier is legitimately in this outlet, just not
    // permitted to restructure it. A 404 here would hide permission bugs.
    expect(cashier.status).toBe(403);

    const manager = await SELF.fetch(url, {
      method: "POST",
      headers: { ...json, ...(await authAs(a, "manager")) },
      body: JSON.stringify({ label: "Meja 98" }),
    });
    expect(manager.status).toBe(201);
  });

  it("still answers 404 for another organisation, not 403", async () => {
    const [a, b] = await Promise.all([
      createTenant("Suriani"),
      createTenant("Rival"),
    ]);

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${b.outletId}/tables`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(a) },
        body: JSON.stringify({ label: "Meja 01" }),
      },
    );
    // Knowing the outlet exists is itself the leak.
    expect(res.status).toBe(404);
  });
});

describe("creating tables", () => {
  it("creates a whole floor in one call", async () => {
    const a = await createTenant("Suriani");
    // Starts at 21 because the seeded outlet already holds "Meja 05" — the
    // collision guard is proved separately, below.
    const labels = Array.from(
      { length: 12 },
      (_, i) => `Meja ${String(i + 21).padStart(2, "0")}`,
    );

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(a) },
        body: JSON.stringify({ labels }),
      },
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as { tables: { qrToken: string }[] };
    expect(body.tables).toHaveLength(12);
    // Every table gets its own secret; a shared or predictable token would
    // reintroduce the ordering-to-someone-else's-table problem.
    expect(new Set(body.tables.map((t) => t.qrToken)).size).toBe(12);
  });

  it("refuses a duplicate label rather than silently skipping it", async () => {
    const a = await createTenant("Suriani");
    const headers = { "Content-Type": "application/json", ...auth(a) };

    // "Meja 05" already exists from the seed.
    const single = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables`,
      { method: "POST", headers, body: JSON.stringify({ label: "meja 05" }) },
    );
    expect(single.status).toBe(409);

    // A bulk create that collides must create nothing at all — a partial
    // floor plan that silently differs from what was asked for would not be
    // noticed until service.
    const bulk = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ labels: ["Meja 20", "Meja 05", "Meja 21"] }),
      },
    );
    expect(bulk.status).toBe(409);

    const after = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
        headers: auth(a),
      })
    ).json()) as { tables: { label: string }[] };
    expect(after.tables.map((t) => t.label)).not.toContain("Meja 20");
  });
});

describe("rotating a QR", () => {
  it("requires explicit confirmation, then kills the old card immediately", async () => {
    const a = await createTenant("Suriani");
    const tables = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
        headers: auth(a),
      })
    ).json()) as { tables: { id: string }[] };
    const tableId = tables.tables[0]!.id;
    const rotateUrl = `https://api.test/api/outlets/${a.outletId}/tables/${tableId}/rotate`;

    // Without confirmation this destructive action must refuse.
    const unconfirmed = await SELF.fetch(rotateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(a) },
      body: JSON.stringify({}),
    });
    expect(unconfirmed.status).toBe(400);

    // The old card still works right up until the rotation.
    expect(
      (await SELF.fetch(`https://api.test/api/t/${a.outletId}/${a.qrToken}`)).status,
    ).toBe(200);

    const rotated = await SELF.fetch(rotateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(a) },
      body: JSON.stringify({ confirm: true }),
    });
    expect(rotated.status).toBe(200);
    const { qrToken: fresh } = (await rotated.json()) as { qrToken: string };

    // Old token dead, new token alive.
    expect(
      (await SELF.fetch(`https://api.test/api/t/${a.outletId}/${a.qrToken}`)).status,
    ).toBe(404);
    expect(
      (await SELF.fetch(`https://api.test/api/t/${a.outletId}/${fresh}`)).status,
    ).toBe(200);
  });
});

describe("archiving a table", () => {
  it("refuses while a bill is still open", async () => {
    const a = await createTenant("Suriani");

    // Open a bill by ordering.
    await SELF.fetch(`https://api.test/api/t/${a.outletId}/${a.qrToken}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: [{ menuItemId: a.itemId, qty: 1 }] }),
    });

    const tables = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
        headers: auth(a),
      })
    ).json()) as { tables: { id: string }[] };

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables/${tables.tables[0]!.id}`,
      { method: "DELETE", headers: auth(a) },
    );
    // Tidying the floor plan mid-service must never strand a table that is
    // still eating.
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "open_session",
    });
  });

  it("keeps history readable and stops the QR working", async () => {
    const a = await createTenant("Suriani");
    const headers = { "Content-Type": "application/json", ...auth(a) };

    // Add a second table, order at it, then archive it.
    const created = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "Meja 77" }),
      })
    ).json()) as { tables: { id: string; qrToken: string }[] };
    const table = created.tables[0]!;

    await SELF.fetch(
      `https://api.test/api/t/${a.outletId}/${table.qrToken}/orders`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: [{ menuItemId: a.itemId, qty: 1 }] }),
      },
    );

    // Close the bill so archiving is allowed, then archive.
    await runInDurableObject(
      env.OUTLET.get(env.OUTLET.idFromName(a.doId)),
      async (_i, state) => {
        state.storage.sql.exec(
          "UPDATE table_sessions SET status = 'closed' WHERE status = 'open'",
        );
      },
    );

    const archived = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables/${table.id}`,
      { method: "DELETE", headers: auth(a) },
    );
    expect(archived.status).toBe(200);

    // Gone from the floor plan...
    const active = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
        headers: auth(a),
      })
    ).json()) as { tables: { label: string }[] };
    expect(active.tables.map((t) => t.label)).not.toContain("Meja 77");

    // ...its QR is dead, so a pocketed card cannot keep ordering...
    expect(
      (await SELF.fetch(`https://api.test/api/t/${a.outletId}/${table.qrToken}`))
        .status,
    ).toBe(404);

    // ...but last month's bill still knows which table it was. This is why
    // archiving exists instead of DELETE.
    const orders = (await (
      await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/orders`, {
        headers: auth(a),
      })
    ).json()) as { orders: { tableLabel: string }[] };
    expect(orders.orders.map((o) => o.tableLabel)).toContain("Meja 77");
  });
});

describe("printable QR cards", () => {
  it("renders one card per active table and none for archived ones", async () => {
    const a = await createTenant("Suriani");
    const headers = { "Content-Type": "application/json", ...auth(a) };

    await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/tables`, {
      method: "POST",
      headers,
      body: JSON.stringify({ labels: ["Meja 06", "Meja 07"] }),
    });

    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables/cards`,
      { headers: auth(a) },
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html.match(/class="card"/g)).toHaveLength(3);
    expect(html).toContain("Meja 05");
    expect(html).toContain("Meja 07");
    expect(html).toContain("Suriani Cawangan");
    // Every card carries a rendered QR, not a placeholder.
    expect(html.match(/<svg/g)?.length).toBeGreaterThanOrEqual(3);

    // No offline mode configured yet, so no outage panel — the card is still
    // complete and correct without it.
    expect(html).not.toContain("Tiada internet?");
  });

  it("adds the outage panel once a local ordering URL exists", async () => {
    const a = await createTenant("Suriani");
    const headers = { "Content-Type": "application/json", ...auth(a) };

    await SELF.fetch(`https://api.test/api/outlets/${a.outletId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        localOrderUrl: "http://192.168.1.50:8080",
        wifiSsid: "Suriani-Guest",
        wifiPassword: "makansedap",
      }),
    });

    const html = await (
      await SELF.fetch(
        `https://api.test/api/outlets/${a.outletId}/tables/cards`,
        { headers: auth(a) },
      )
    ).text();

    expect(html).toContain("Tiada internet?");
    expect(html).toContain("Sambung WiFi");
    expect(html).toContain("Pesan di sini");
  });

  it("is not something a cashier can pull up", async () => {
    const a = await createTenant("Suriani");
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${a.outletId}/tables/cards`,
      { headers: await authAs(a, "cashier") },
    );
    // The card page embeds the guest WiFi password.
    expect(res.status).toBe(403);
  });
});
