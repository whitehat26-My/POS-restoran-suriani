/**
 * One Durable Object per outlet. One restaurant branch, one SQLite database.
 *
 * This class is the entire data plane. Everything a branch trades on — menu,
 * tables, open bills, orders, payments — lives in here and nowhere else.
 *
 * Two properties come free with this shape and are worth naming, because they
 * are the reason it was chosen over a shared table with an `org_id` column:
 *
 *  1. Isolation is structural. There is no query in this file that *could*
 *     reach another outlet's data, because another outlet's data is in a
 *     different database. Not "we remembered the WHERE clause" — impossible.
 *
 *  2. Writes are single-threaded. Two phones at one table ordering in the same
 *     instant, or a cashier closing a bill while a customer adds a drink,
 *     serialise naturally. On a shared database each of those needs a
 *     hand-written transaction to avoid double-charging or losing an order.
 */
import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { and, eq, inArray } from "drizzle-orm";

import * as schema from "./schema";
import { runMigrations } from "./migrations";
import { id, ulid } from "../lib/ids";
import { lineTotalSen, type Modifier, type Sen } from "../lib/money";

export interface SeedCategory {
  id: string;
  nameMs: string;
  nameEn: string;
  sortOrder: number;
}

export interface SeedItem {
  id: string;
  categoryId: string;
  nameMs: string;
  nameEn: string;
  descMs?: string;
  descEn?: string;
  priceSen: Sen;
  tags?: string[];
  prepMinutes?: number;
  isAvailable?: boolean;
}

export interface SeedTable {
  id: string;
  label: string;
  qrToken: string;
}

export interface PlaceOrderLine {
  menuItemId: string;
  qty: number;
  notes?: string;
  modifiers?: Modifier[];
}

export interface PlaceOrderInput {
  qrToken: string;
  lines: PlaceOrderLine[];
  /** Client-generated ULID. Replaying the same one is a no-op. */
  clientUlid?: string;
  source?: "qr" | "counter";
  deviceId?: string;
}

export interface PlacedOrder {
  orderId: string;
  sessionId: string;
  tableLabel: string;
  totalSen: Sen;
  clientUlid: string;
  /** True when this call replayed an order that already existed. */
  duplicate: boolean;
}

/**
 * Ordering failures are expected conditions, not crashes.
 *
 * An unknown table token is the single most common request this system will
 * ever reject — stale printed QRs, mistyped URLs, bots probing. Throwing
 * across the Durable Object RPC boundary logs every one of those as an
 * uncaught exception, which buries real faults in noise. So expected outcomes
 * come back as values and only genuine bugs throw.
 */
export type PlaceOrderResult =
  | { ok: true; order: PlacedOrder }
  | {
      ok: false;
      error: "unknown_table" | "empty_order" | "unknown_item" | "unavailable";
      detail?: string;
    };

export class OutletDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase<typeof schema>;
  private version = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });

    // Migrate before this object serves anything. A branch closed for a month
    // migrates itself on its next order, with no fleet-wide job to run.
    ctx.blockConcurrencyWhile(async () => {
      this.version = runMigrations(ctx.storage.sql);
    });
  }

  async schemaVersion(): Promise<number> {
    return this.version;
  }

  /** Install menu and tables. Used by the seed script and by tests. */
  async installSeed(input: {
    categories: SeedCategory[];
    items: SeedItem[];
    tables: SeedTable[];
  }): Promise<{ categories: number; items: number; tables: number }> {
    for (const c of input.categories) {
      await this.db
        .insert(schema.menuCategories)
        .values({
          id: c.id,
          nameMs: c.nameMs,
          nameEn: c.nameEn,
          sortOrder: c.sortOrder,
        })
        .onConflictDoNothing();
    }

    for (const i of input.items) {
      await this.db
        .insert(schema.menuItems)
        .values({
          id: i.id,
          categoryId: i.categoryId,
          nameMs: i.nameMs,
          nameEn: i.nameEn,
          descMs: i.descMs ?? null,
          descEn: i.descEn ?? null,
          priceSen: i.priceSen,
          tags: JSON.stringify(i.tags ?? []),
          isAvailable: i.isAvailable === false ? 0 : 1,
          prepMinutes: i.prepMinutes ?? 10,
        })
        .onConflictDoNothing();
    }

    for (const t of input.tables) {
      await this.db
        .insert(schema.tables)
        .values({ id: t.id, label: t.label, qrToken: t.qrToken })
        .onConflictDoNothing();
    }

    return {
      categories: input.categories.length,
      items: input.items.length,
      tables: input.tables.length,
    };
  }

  async listMenu() {
    const categories = await this.db.select().from(schema.menuCategories);
    const items = await this.db.select().from(schema.menuItems);
    return {
      categories: categories.sort((a, b) => a.sortOrder - b.sortOrder),
      items: items.map((i) => ({ ...i, tags: JSON.parse(i.tags) as string[] })),
    };
  }

  async listTables() {
    return this.db.select().from(schema.tables);
  }

  /**
   * Resolve a table from its QR secret.
   *
   * Returns null rather than throwing, so the caller can answer 404 without
   * distinguishing "no such token" from "token belongs elsewhere".
   */
  async resolveTable(token: string) {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.qrToken, token))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Place an order against a table's QR token.
   *
   * Idempotent on `clientUlid`. A tablet that queued orders during an outage
   * can replay its whole op log without creating duplicates — which is the
   * property that makes offline sync safe rather than merely optimistic.
   */
  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const clientUlid = input.clientUlid ?? ulid();

    const table = await this.resolveTable(input.qrToken);
    if (!table) return { ok: false, error: "unknown_table" };
    if (input.lines.length === 0) return { ok: false, error: "empty_order" };

    // Replay guard, checked before anything is written.
    const existing = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.clientUlid, clientUlid))
      .limit(1);

    if (existing[0]) {
      const prior = existing[0];
      const priorItems = await this.db
        .select()
        .from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, prior.id));
      return {
        ok: true,
        order: {
          orderId: prior.id,
          sessionId: prior.sessionId,
          tableLabel: table.label,
          totalSen: priorItems.reduce(
            (sum, li) =>
              sum +
              lineTotalSen(
                li.unitPriceSen,
                li.qty,
                JSON.parse(li.modifiers) as Modifier[],
              ),
            0,
          ),
          clientUlid,
          duplicate: true,
        },
      };
    }

    const now = Date.now();

    // Join the table's open bill, or open one. Two phones at the same table
    // land on the same session — that is the feature, not an accident.
    let session = (
      await this.db
        .select()
        .from(schema.tableSessions)
        .where(
          and(
            eq(schema.tableSessions.tableId, table.id),
            inArray(schema.tableSessions.status, ["open", "bill_requested"]),
          ),
        )
        .limit(1)
    )[0];

    if (!session) {
      const newSession = {
        id: id("ses"),
        tableId: table.id,
        openedAt: now,
        closedAt: null,
        status: "open" as const,
      };
      await this.db.insert(schema.tableSessions).values(newSession);
      session = newSession;
    }

    // Snapshot prices from the menu at this instant.
    const menuIds = input.lines.map((l) => l.menuItemId);
    const menuRows = await this.db
      .select()
      .from(schema.menuItems)
      .where(inArray(schema.menuItems.id, menuIds));
    const menu = new Map(menuRows.map((m) => [m.id, m]));

    const orderId = id("ord");
    let totalSen = 0;
    const itemRows: (typeof schema.orderItems.$inferInsert)[] = [];

    for (const line of input.lines) {
      const item = menu.get(line.menuItemId);
      if (!item) {
        return { ok: false, error: "unknown_item", detail: line.menuItemId };
      }
      // 86-ing: an item marked habis stops being orderable immediately, even
      // for a phone already sitting on the menu page.
      if (item.isAvailable === 0) {
        return { ok: false, error: "unavailable", detail: item.nameMs };
      }

      const modifiers = line.modifiers ?? [];
      totalSen += lineTotalSen(item.priceSen, line.qty, modifiers);

      itemRows.push({
        id: id("oi"),
        orderId,
        menuItemId: item.id,
        nameMs: item.nameMs,
        nameEn: item.nameEn,
        qty: line.qty,
        // Snapshot. If the price changes at 3pm, this bill does not.
        unitPriceSen: item.priceSen,
        notes: line.notes ?? null,
        modifiers: JSON.stringify(modifiers),
      });
    }

    await this.db.insert(schema.orders).values({
      id: orderId,
      sessionId: session.id,
      placedAt: now,
      source: input.source ?? "qr",
      clientUlid,
      status: "placed",
      voidReason: null,
    });
    await this.db.insert(schema.orderItems).values(itemRows);

    // The append-only sync spine.
    await this.db.insert(schema.opLog).values({
      clientUlid,
      deviceId: input.deviceId ?? null,
      kind: "order.placed",
      payload: JSON.stringify({ orderId, sessionId: session.id, totalSen }),
      appliedAt: now,
    });

    // Phase 4 drains this queue to a real printer.
    await this.db.insert(schema.printJobs).values({
      id: id("pj"),
      orderId,
      target: "kitchen",
      payload: JSON.stringify({
        table: table.label,
        lines: itemRows.map((r) => ({ qty: r.qty, name: r.nameMs })),
        at: now,
      }),
      status: "queued",
      attempts: 0,
      createdAt: now,
    });

    await this.db
      .update(schema.tables)
      .set({ status: "ordering" })
      .where(eq(schema.tables.id, table.id));

    return {
      ok: true,
      order: {
        orderId,
        sessionId: session.id,
        tableLabel: table.label,
        totalSen,
        clientUlid,
        duplicate: false,
      },
    };
  }

  /** Every order in this outlet, newest first. */
  async listOrders(): Promise<
    Array<{
      id: string;
      tableLabel: string;
      placedAt: number;
      status: string;
      totalSen: Sen;
    }>
  > {
    const orders = await this.db.select().from(schema.orders);
    const sessions = await this.db.select().from(schema.tableSessions);
    const tables = await this.db.select().from(schema.tables);
    const items = await this.db.select().from(schema.orderItems);

    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const tableById = new Map(tables.map((t) => [t.id, t]));

    return orders
      .map((o) => {
        const sessionRow = sessionById.get(o.sessionId);
        const tableRow = sessionRow
          ? tableById.get(sessionRow.tableId)
          : undefined;
        const totalSen = items
          .filter((li) => li.orderId === o.id)
          .reduce(
            (sum, li) =>
              sum +
              lineTotalSen(
                li.unitPriceSen,
                li.qty,
                JSON.parse(li.modifiers) as Modifier[],
              ),
            0,
          );
        return {
          id: o.id,
          tableLabel: tableRow?.label ?? "?",
          placedAt: o.placedAt,
          status: o.status,
          totalSen,
        };
      })
      .sort((a, b) => b.placedAt - a.placedAt);
  }

  /** Queued kitchen tickets. Phase 4 turns these into ESC/POS bytes. */
  async pendingPrintJobs() {
    return this.db
      .select()
      .from(schema.printJobs)
      .where(eq(schema.printJobs.status, "queued"));
  }

  /** Total taken today, for the nightly rollup into D1. */
  async salesTotalSen(): Promise<Sen> {
    const orders = await this.db.select().from(schema.orders);
    const live = new Set(
      orders.filter((o) => o.status !== "voided").map((o) => o.id),
    );
    const items = await this.db.select().from(schema.orderItems);
    return items
      .filter((li) => live.has(li.orderId))
      .reduce(
        (sum, li) =>
          sum +
          lineTotalSen(
            li.unitPriceSen,
            li.qty,
            JSON.parse(li.modifiers) as Modifier[],
          ),
        0,
      );
  }
}
