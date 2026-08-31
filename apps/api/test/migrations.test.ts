import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { MIGRATIONS, TARGET_VERSION, runMigrations } from "../src/outlet/migrations";
import { doId } from "../src/lib/ids";

function freshOutlet() {
  return env.OUTLET.get(env.OUTLET.idFromName(doId()));
}

describe("per-outlet migrations", () => {
  it("migrates a brand new outlet on first wake", async () => {
    const stub = freshOutlet();
    expect(await stub.schemaVersion()).toBe(TARGET_VERSION);
  });

  it("is idempotent — re-running changes nothing", async () => {
    const stub = freshOutlet();
    await stub.schemaVersion(); // force construction

    await runInDurableObject(stub, async (_instance, state) => {
      const first = runMigrations(state.storage.sql);
      const second = runMigrations(state.storage.sql);
      const third = runMigrations(state.storage.sql);

      expect(first).toBe(TARGET_VERSION);
      expect(second).toBe(TARGET_VERSION);
      expect(third).toBe(TARGET_VERSION);

      // One row per applied migration, not one per call. If this grows, the
      // runner is re-applying migrations and would eventually fail on a
      // CREATE TABLE that already exists.
      const rows = [
        ...state.storage.sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM _schema_version",
        ),
      ];
      expect(rows[0]!.n).toBe(MIGRATIONS.length);
    });
  });

  it("creates every table the outlet schema needs", async () => {
    const stub = freshOutlet();
    await stub.schemaVersion();

    await runInDurableObject(stub, async (_instance, state) => {
      const names = [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table'",
        ),
      ].map((r) => r.name);

      for (const expected of [
        "menu_categories",
        "menu_items",
        "tables",
        "table_sessions",
        "orders",
        "order_items",
        "payments",
        "print_jobs",
        "op_log",
        "audit_log",
        "daily_closings",
      ]) {
        expect(names, `missing table ${expected}`).toContain(expected);
      }
    });
  });

  it("carries no org or tenant column anywhere", async () => {
    const stub = freshOutlet();
    await stub.schemaVersion();

    // Isolation here is the storage boundary. A tenant column would mean the
    // boundary had quietly become a WHERE clause again.
    await runInDurableObject(stub, async (_instance, state) => {
      const tables = [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        ),
      ].map((r) => r.name);

      for (const table of tables) {
        const columns = [
          ...state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(${table})`,
          ),
        ].map((c) => c.name);
        expect(columns, `${table} leaks tenancy`).not.toContain("org_id");
        expect(columns, `${table} leaks tenancy`).not.toContain("outlet_id");
      }
    });
  });
});
