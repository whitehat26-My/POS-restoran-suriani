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
import { and, eq, gte, inArray } from "drizzle-orm";

import * as schema from "./schema";
import { runMigrations } from "./migrations";
import { id, qrToken, ulid } from "../lib/ids";
import { batchForSql } from "../lib/chunk";
import { lineTotalSen, type Modifier, type Sen } from "../lib/money";
import { groupLinesByStation } from "@suriani/core/stations";
import {
  renderKitchenTicket,
  renderReceipt,
  type ReceiptLine,
  type TicketLine as PrintLine,
} from "@suriani/escpos/templates";
import {
  broadcast,
  type FloorTable,
  type FloorZone,
  type OutletEvent,
  type TicketLine,
} from "./ws";

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

export interface SeedStation {
  id: string;
  name: string;
  target: string;
  isDefault?: boolean;
  sortOrder?: number;
  /** Which menu categories print here. Replaced wholesale on every apply. */
  categoryIds?: string[];
}

export interface SeedModifierGroup {
  id: string;
  menuItemId: string;
  nameMs: string;
  nameEn: string;
  minSelect?: number;
  maxSelect?: number;
  sortOrder?: number;
  options: {
    id: string;
    labelMs: string;
    labelEn: string;
    priceDeltaSen?: Sen;
    sortOrder?: number;
  }[];
}

/** A modifier group as the menu endpoints hand it to a client. */
export interface MenuModifierGroup {
  id: string;
  nameMs: string;
  nameEn: string;
  minSelect: number;
  maxSelect: number;
  options: {
    id: string;
    labelMs: string;
    labelEn: string;
    priceDeltaSen: Sen;
  }[];
}

export interface PlaceOrderLine {
  menuItemId: string;
  qty: number;
  notes?: string;
  /**
   * Ids of the chosen options — deliberately NOT prices.
   *
   * The server resolves each id to its own label and price delta. A price that
   * arrives from a phone is a price the customer picked, which is how you end
   * up selling RM12 nasi lemak for RM2.
   */
  modifierOptionIds?: string[];
}

/** One entry from a device's op log. Mirrors @suriani/offline's `Op`. */
export interface SyncOp {
  clientUlid: string;
  deviceId?: string;
  /** The device's clock, preserved so replayed sales land on the right day. */
  at: number;
  body:
    | {
        kind: "order.place";
        tableId: string;
        lines: PlaceOrderLine[];
        expectedTotalSen?: Sen;
        /** Paper already came out of this device's own printer. */
        printedLocally?: boolean;
      }
    | { kind: "order.serve"; orderId: string }
    | { kind: "session.close"; sessionId: string }
    | { kind: "item.availability"; itemId: string; available: boolean };
}

export interface SyncOpResult {
  clientUlid: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  orderId?: string;
}

export interface PlaceOrderInput {
  /** Customer path: the table's QR secret. */
  qrToken?: string;
  /**
   * Staff path: the POS knows table ids, not QR secrets. Exactly one of
   * qrToken / tableId must be set.
   */
  tableId?: string;
  lines: PlaceOrderLine[];
  /** Client-generated ULID. Replaying the same one is a no-op. */
  clientUlid?: string;
  source?: "qr" | "counter";
  deviceId?: string;
  /**
   * This order was taken while the till was offline and is being replayed.
   *
   * It skips the 86 check, because the food was ordered hours ago and very
   * likely eaten: refusing to record it means the restaurant serves a plate
   * it never bills for. 86-ing exists to stop *new* orders, not to erase old
   * ones. The skip is audited.
   */
  replay?: boolean;
  /** When the till took it. Replay preserves the real time, not sync time. */
  placedAt?: number;
  /**
   * What the till showed the customer, for reconciliation only.
   *
   * Never used to bill. The server prices from its own tables exactly as it
   * always has; this is here so that a divergence — the owner edited a price
   * during the outage — lands in the audit log instead of in the accounts.
   */
  expectedTotalSen?: Sen;
  /**
   * The tablet already printed this order's dockets itself.
   *
   * Only reachable through the staff-authed sync route, and only ever set by
   * a device that watched `printVia` succeed. When it is set, the fan-out
   * below is skipped — otherwise the kitchen gets the same order twice, once
   * from the tablet's own printer and once from the queue.
   *
   * A failed print leaves it unset and this path is unchanged, which is the
   * property that matters: the fallback of a broken printer is the ordinary
   * queue, never silence.
   */
  printedLocally?: boolean;
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
      error:
        | "unknown_table"
        | "empty_order"
        | "unknown_item"
        | "unavailable"
        | "unknown_option"
        | "option_required"
        | "too_many_options";
      detail?: string;
    };

/**
 * Turn a stored job payload into ESC/POS bytes, base64 for JSON transport.
 *
 * Rendering from the stored snapshot (not from live menu data) is what makes a
 * reprint of last week's docket identical even after prices changed.
 */
function renderJob(payloadJson: string, outletName: string): string {
  const payload = JSON.parse(payloadJson) as {
    kind?: string;
    stationName?: string;
    tableLabel?: string;
    orderCode?: string;
    placedAt?: number;
    reprint?: boolean;
    lines?: PrintLine[];
    receiptLines?: ReceiptLine[];
    totalSen?: number;
    itemCount?: number;
    method?: string;
  };

  const bytes =
    payload.kind === "receipt"
      ? renderReceipt({
          outletName,
          tableLabel: payload.tableLabel ?? "?",
          orderCode: payload.orderCode ?? "",
          paidAt: new Date(payload.placedAt ?? 0),
          lines: payload.receiptLines ?? [],
          totalSen: payload.totalSen ?? 0,
          itemCount: payload.itemCount,
          method: payload.method,
          reprint: payload.reprint === true,
        })
      : renderKitchenTicket({
          outletName,
          stationName: payload.stationName ?? "Dapur",
          tableLabel: payload.tableLabel ?? "?",
          orderCode: payload.orderCode ?? "",
          placedAt: new Date(payload.placedAt ?? 0),
          lines: payload.lines ?? [],
          reprint: payload.reprint === true,
        });

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

  /* ---------------------------------------------------------------- *
   * Realtime
   *
   * The worker authenticates the till (session cookie + tenant door) and
   * forwards the upgrade here. Hibernatable sockets: an idle till keeps its
   * connection while this object sleeps, at no duration cost. Outgoing
   * messages are free, and a POS mostly listens.
   * ---------------------------------------------------------------- */

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    // Every connection starts from truth: full snapshot before any delta,
    // so a reconnecting till never renders stale state.
    server.send(JSON.stringify(await this.buildSnapshot()));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // The till speaks one word. Everything that changes state goes through
    // the authenticated HTTP routes, never through the socket.
    if (message === "resync") {
      ws.send(JSON.stringify(await this.buildSnapshot()));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // compat date >= 2026-04-07 auto-replies to Close; nothing to do.
    void ws;
    void code;
    void reason;
  }

  private async buildSnapshot(): Promise<OutletEvent> {
    const [zones, floor, settings] = await Promise.all([
      this.listZones(),
      this.getFloor(),
      this.getSettings(),
    ]);
    return {
      type: "snapshot",
      zones: zones as FloorZone[],
      tables: floor,
      menuVersion: settings.menuVersion ?? 1,
    };
  }

  /** Tables with their open bill, the shape the floor map renders. */
  async getFloor(): Promise<FloorTable[]> {
    const tables = await this.listTables();
    const sessions = await this.db
      .select()
      .from(schema.tableSessions)
      .where(
        inArray(schema.tableSessions.status, ["open", "bill_requested"]),
      );
    const openByTable = new Map(sessions.map((s) => [s.tableId, s]));

    const sessionIds = sessions.map((s) => s.id);
    const orders = sessionIds.length
      ? await this.db
          .select()
          .from(schema.orders)
          .where(inArray(schema.orders.sessionId, sessionIds))
      : [];
    const live = orders.filter((o) => o.status !== "voided");
    const orderIds = live.map((o) => o.id);
    const items = orderIds.length
      ? await this.db
          .select()
          .from(schema.orderItems)
          .where(inArray(schema.orderItems.orderId, orderIds))
      : [];

    const orderTotals = new Map<string, Sen>();
    for (const li of items) {
      const total =
        (orderTotals.get(li.orderId) ?? 0) +
        lineTotalSen(li.unitPriceSen, li.qty, JSON.parse(li.modifiers) as Modifier[]);
      orderTotals.set(li.orderId, total);
    }
    const sessionTotals = new Map<string, { totalSen: Sen; count: number }>();
    for (const o of live) {
      const agg = sessionTotals.get(o.sessionId) ?? { totalSen: 0, count: 0 };
      agg.totalSen += orderTotals.get(o.id) ?? 0;
      agg.count += 1;
      sessionTotals.set(o.sessionId, agg);
    }

    return tables.map((t) => {
      const session = openByTable.get(t.id);
      const agg = session ? sessionTotals.get(session.id) : undefined;
      return {
        id: t.id,
        label: t.label,
        zoneId: t.zoneId,
        capacity: t.capacity,
        sortOrder: t.sortOrder,
        status: t.status,
        session: session
          ? {
              id: session.id,
              openedAt: session.openedAt,
              status: session.status,
              totalSen: agg?.totalSen ?? 0,
              orderCount: agg?.count ?? 0,
            }
          : null,
      };
    });
  }

  /**
   * Make this outlet's menu match the payload exactly.
   *
   * Upsert *and prune*: a category or dish that is no longer in the payload is
   * removed, because leaving it behind is how an outlet ends up showing the
   * old four headings and the new eight at the same time. Deleting is safe
   * precisely because `order_items` snapshots the dish name and its price —
   * last month's bill still reads correctly with the dish gone.
   *
   * Two things are deliberately preserved rather than overwritten:
   *   - `is_available`, because 86-ing belongs to whoever is on shift, not to
   *     a seed file that would silently un-86 a dish the kitchen ran out of;
   *   - `qr_token` and every table, which this method does not touch at all.
   *
   * Bumps `menu_version` so a phone already sitting on the menu refetches.
   */
  async applyMenu(input: {
    categories: SeedCategory[];
    items: SeedItem[];
    modifierGroups?: SeedModifierGroup[];
    stations?: SeedStation[];
    /**
     * Delete what the payload no longer mentions. True by default, because
     * "make the menu match" is what this method is for. `installSeed` turns it
     * off: a first seed has nothing to prune, and an empty menu payload there
     * means "just add these tables", not "empty the menu".
     */
    prune?: boolean;
  }): Promise<{
    categories: number;
    items: number;
    removedCategories: number;
    removedItems: number;
    menuVersion: number;
  }> {
    const categoryIds = input.categories.map((c) => c.id);
    const itemIds = input.items.map((i) => i.id);
    const groups = input.modifierGroups ?? [];
    const groupIds = groups.map((g) => g.id);
    const optionIds = groups.flatMap((g) => g.options.map((o) => o.id));

    for (const c of input.categories) {
      await this.db
        .insert(schema.menuCategories)
        .values({
          id: c.id,
          nameMs: c.nameMs,
          nameEn: c.nameEn,
          sortOrder: c.sortOrder,
        })
        .onConflictDoUpdate({
          target: schema.menuCategories.id,
          set: { nameMs: c.nameMs, nameEn: c.nameEn, sortOrder: c.sortOrder },
        });
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
        .onConflictDoUpdate({
          target: schema.menuItems.id,
          // isAvailable is absent on purpose: see the note above.
          set: {
            categoryId: i.categoryId,
            nameMs: i.nameMs,
            nameEn: i.nameEn,
            descMs: i.descMs ?? null,
            descEn: i.descEn ?? null,
            priceSen: i.priceSen,
            tags: JSON.stringify(i.tags ?? []),
            prepMinutes: i.prepMinutes ?? 10,
          },
        });
    }

    for (const g of groups) {
      await this.db
        .insert(schema.modifierGroups)
        .values({
          id: g.id,
          menuItemId: g.menuItemId,
          nameMs: g.nameMs,
          nameEn: g.nameEn,
          minSelect: g.minSelect ?? 0,
          maxSelect: g.maxSelect ?? 1,
          sortOrder: g.sortOrder ?? 0,
        })
        .onConflictDoUpdate({
          target: schema.modifierGroups.id,
          set: {
            menuItemId: g.menuItemId,
            nameMs: g.nameMs,
            nameEn: g.nameEn,
            minSelect: g.minSelect ?? 0,
            maxSelect: g.maxSelect ?? 1,
            sortOrder: g.sortOrder ?? 0,
          },
        });
      for (const o of g.options) {
        await this.db
          .insert(schema.modifierOptions)
          .values({
            id: o.id,
            groupId: g.id,
            labelMs: o.labelMs,
            labelEn: o.labelEn,
            priceDeltaSen: o.priceDeltaSen ?? 0,
            sortOrder: o.sortOrder ?? 0,
          })
          .onConflictDoUpdate({
            target: schema.modifierOptions.id,
            set: {
              groupId: g.id,
              labelMs: o.labelMs,
              labelEn: o.labelEn,
              priceDeltaSen: o.priceDeltaSen ?? 0,
              sortOrder: o.sortOrder ?? 0,
            },
          });
      }
    }

    for (const station of input.stations ?? []) {
      await this.db
        .insert(schema.printStations)
        .values({
          id: station.id,
          name: station.name,
          target: station.target,
          enabled: 1,
          isDefault: station.isDefault ? 1 : 0,
          sortOrder: station.sortOrder ?? 0,
        })
        .onConflictDoUpdate({
          target: schema.printStations.id,
          // `enabled` is left alone: a station switched off at the till stays
          // off. Routing is what this call owns.
          set: {
            name: station.name,
            target: station.target,
            isDefault: station.isDefault ? 1 : 0,
            sortOrder: station.sortOrder ?? 0,
          },
        });

      // Routing is replaced wholesale rather than merged. Categories move
      // between stations; a leftover row would quietly print nasi at the
      // drinks counter forever.
      await this.db
        .delete(schema.stationRoutes)
        .where(eq(schema.stationRoutes.stationId, station.id));
      for (const categoryId of station.categoryIds ?? []) {
        await this.db
          .insert(schema.stationRoutes)
          .values({ stationId: station.id, categoryId });
      }
    }

    // Prune, in dependency order: options, groups, items, categories.
    const removed =
      input.prune === false
        ? { categories: 0, items: 0 }
        : await this.pruneMenu({ categoryIds, itemIds, groupIds, optionIds });

    const settings = await this.getSettings();
    const menuVersion = (settings.menuVersion ?? 1) + 1;
    await this.db
      .update(schema.settings)
      .set({ menuVersion, updatedAt: Date.now() })
      .where(eq(schema.settings.id, 1));

    broadcast(this.ctx, { type: "menu.changed", menuVersion });

    return {
      categories: input.categories.length,
      items: input.items.length,
      removedCategories: removed.categories,
      removedItems: removed.items,
      menuVersion,
    };
  }

  /** Everything the payload no longer mentions, deleted in dependency order. */
  private async pruneMenu(keep: {
    categoryIds: string[];
    itemIds: string[];
    groupIds: string[];
    optionIds: string[];
  }): Promise<{ categories: number; items: number }> {
    const staleItems = (await this.db.select().from(schema.menuItems)).filter(
      (i) => !keep.itemIds.includes(i.id),
    );
    const staleCategories = (
      await this.db.select().from(schema.menuCategories)
    ).filter((c) => !keep.categoryIds.includes(c.id));

    // Options first, then their groups, so nothing is ever briefly orphaned.
    const staleOptions = (
      await this.db.select().from(schema.modifierOptions)
    ).filter((o) => !keep.optionIds.includes(o.id));
    for (const batch of batchForSql(staleOptions, 1)) {
      await this.db
        .delete(schema.modifierOptions)
        .where(
          inArray(
            schema.modifierOptions.id,
            batch.map((o) => o.id),
          ),
        );
    }

    const staleGroups = (
      await this.db.select().from(schema.modifierGroups)
    ).filter(
      (g) => !keep.groupIds.includes(g.id) || !keep.itemIds.includes(g.menuItemId),
    );
    for (const batch of batchForSql(staleGroups, 1)) {
      await this.db
        .delete(schema.modifierGroups)
        .where(
          inArray(
            schema.modifierGroups.id,
            batch.map((g) => g.id),
          ),
        );
    }

    for (const batch of batchForSql(staleItems, 1)) {
      await this.db
        .delete(schema.menuItems)
        .where(
          inArray(
            schema.menuItems.id,
            batch.map((i) => i.id),
          ),
        );
    }

    for (const batch of batchForSql(staleCategories, 1)) {
      const ids = batch.map((c) => c.id);
      await this.db
        .delete(schema.stationRoutes)
        .where(inArray(schema.stationRoutes.categoryId, ids));
      await this.db
        .delete(schema.menuCategories)
        .where(inArray(schema.menuCategories.id, ids));
    }

    return { categories: staleCategories.length, items: staleItems.length };
  }

  /** Install menu and tables. Used by the seed script and by tests. */
  async installSeed(input: {
    categories: SeedCategory[];
    items: SeedItem[];
    tables: SeedTable[];
    modifierGroups?: SeedModifierGroup[];
    stations?: SeedStation[];
    /** This branch's name, so its printed slips carry it and not a default. */
    outletName?: string;
  }): Promise<{ categories: number; items: number; tables: number }> {
    if (input.outletName) {
      await this.updateSettings({ outletName: input.outletName });
    }

    await this.applyMenu({
      categories: input.categories,
      items: input.items,
      modifierGroups: input.modifierGroups,
      stations: input.stations,
      prune: false,
    });

    // Tables are insert-only, always. `table_sessions.table_id` points at
    // these rows, so pruning them would turn "Meja 05" into "?" in every
    // historical bill this outlet has ever taken.
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
    const groups = await this.db.select().from(schema.modifierGroups);
    const options = await this.db.select().from(schema.modifierOptions);

    const optionsByGroup = new Map<string, typeof options>();
    for (const o of options) {
      const list = optionsByGroup.get(o.groupId) ?? [];
      list.push(o);
      optionsByGroup.set(o.groupId, list);
    }
    const groupsByItem = new Map<string, MenuModifierGroup[]>();
    for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const list = groupsByItem.get(g.menuItemId) ?? [];
      list.push({
        id: g.id,
        nameMs: g.nameMs,
        nameEn: g.nameEn,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        options: (optionsByGroup.get(g.id) ?? [])
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((o) => ({
            id: o.id,
            labelMs: o.labelMs,
            labelEn: o.labelEn,
            priceDeltaSen: o.priceDeltaSen,
          })),
      });
      groupsByItem.set(g.menuItemId, list);
    }

    return {
      categories: categories.sort((a, b) => a.sortOrder - b.sortOrder),
      items: items.map((i) => ({
        ...i,
        tags: JSON.parse(i.tags) as string[],
        modifierGroups: groupsByItem.get(i.id) ?? [],
      })),
    };
  }

  /** Active tables by default; archived rows are history, not floor plan. */
  async listTables(includeArchived = false) {
    const rows = await this.db.select().from(schema.tables);
    const visible = includeArchived
      ? rows
      : rows.filter((t) => t.archivedAt === null);
    return visible.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
    );
  }

  async listZones() {
    const rows = await this.db.select().from(schema.zones);
    return rows.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * Resolve a table from its QR secret.
   *
   * Returns null rather than throwing, so the caller can answer 404 without
   * distinguishing "no such token" from "token belongs elsewhere".
   *
   * An archived table resolves to null: taking its card off the floor must
   * stop its QR working, or a pocketed card keeps ordering forever.
   */
  async resolveTable(token: string) {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.qrToken, token))
      .limit(1);
    const table = rows[0];
    if (!table || table.archivedAt !== null) return null;
    return table;
  }

  /** Staff-path lookup. Archived tables are off the floor here too. */
  private async resolveTableById(tableId: string) {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, tableId))
      .limit(1);
    const table = rows[0];
    if (!table || table.archivedAt !== null) return null;
    return table;
  }

  /* ---------------------------------------------------------------- *
   * Floor plan configuration
   * ---------------------------------------------------------------- */

  private async labelTaken(label: string, exceptId?: string): Promise<boolean> {
    const rows = await this.db.select().from(schema.tables);
    return rows.some(
      (t) =>
        t.archivedAt === null &&
        t.id !== exceptId &&
        t.label.trim().toLowerCase() === label.trim().toLowerCase(),
    );
  }

  private async audit(action: string, detail: string, userId?: string) {
    await this.db.insert(schema.auditLog).values({
      id: id("aud"),
      userId: userId ?? null,
      action,
      detail,
      at: Date.now(),
    });
  }

  /**
   * The audit trail, newest first.
   *
   * Every void, every price divergence, every rotated QR. Phase 7's owner
   * console reads this; for now it is how a support question gets an answer
   * instead of a shrug.
   */
  async recentAudit(limit = 50) {
    const rows = await this.db.select().from(schema.auditLog);
    return rows.sort((a, b) => b.at - a.at).slice(0, Math.min(limit, 500));
  }

  /**
   * Create tables in one call.
   *
   * Labels come from the caller rather than being expanded from a pattern
   * here, so the preview a manager sees before pressing Create is exactly what
   * gets created — there is no second implementation to disagree with.
   *
   * All-or-nothing on collisions: silently skipping duplicates would leave a
   * floor plan that does not match what was asked for, and nobody would notice
   * until service.
   */
  async createTables(input: {
    labels: string[];
    zoneId?: string | null;
    capacity?: number | null;
    userId?: string;
  }): Promise<
    | { ok: true; tables: { id: string; label: string; qrToken: string }[] }
    | { ok: false; error: "label_taken" | "empty"; detail?: string }
  > {
    const labels = input.labels.map((l) => l.trim()).filter(Boolean);
    if (labels.length === 0) return { ok: false, error: "empty" };

    const seen = new Set<string>();
    for (const label of labels) {
      const key = label.toLowerCase();
      if (seen.has(key)) {
        return { ok: false, error: "label_taken", detail: label };
      }
      seen.add(key);
      if (await this.labelTaken(label)) {
        return { ok: false, error: "label_taken", detail: label };
      }
    }

    const existing = await this.db.select().from(schema.tables);
    let nextOrder = existing.reduce((m, t) => Math.max(m, t.sortOrder), 0);

    const created = labels.map((label) => ({
      id: id("tbl"),
      label,
      qrToken: qrToken(),
      status: "empty" as const,
      zoneId: input.zoneId ?? null,
      capacity: input.capacity ?? null,
      sortOrder: ++nextOrder,
      archivedAt: null,
      tokenRotatedAt: null,
    }));

    // 9 columns per row — a 12-table floor would exceed the 100 bound-
    // parameter cap as a single INSERT.
    for (const batch of batchForSql(created, 9)) {
      await this.db.insert(schema.tables).values(batch);
    }
    await this.audit(
      "tables.created",
      JSON.stringify({ labels }),
      input.userId,
    );

    return {
      ok: true,
      tables: created.map((t) => ({
        id: t.id,
        label: t.label,
        qrToken: t.qrToken,
      })),
    };
  }

  async updateTable(input: {
    tableId: string;
    label?: string;
    zoneId?: string | null;
    capacity?: number | null;
    sortOrder?: number;
    userId?: string;
  }): Promise<
    | { ok: true }
    | { ok: false; error: "not_found" | "label_taken"; detail?: string }
  > {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, input.tableId))
      .limit(1);
    const table = rows[0];
    if (!table) return { ok: false, error: "not_found" };

    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) return { ok: false, error: "label_taken", detail: "" };
      if (await this.labelTaken(label, table.id)) {
        return { ok: false, error: "label_taken", detail: label };
      }
    }

    await this.db
      .update(schema.tables)
      .set({
        ...(input.label !== undefined ? { label: input.label.trim() } : {}),
        ...(input.zoneId !== undefined ? { zoneId: input.zoneId } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
      })
      .where(eq(schema.tables.id, input.tableId));

    await this.audit(
      "table.updated",
      JSON.stringify({ tableId: input.tableId, label: input.label }),
      input.userId,
    );
    return { ok: true };
  }

  /**
   * Issue a new QR secret for a table.
   *
   * This instantly kills the card sitting on that table, so the caller must
   * pass an explicit confirmation and it is always written to the audit log.
   * Used when a card is photographed, copied, or walks off.
   */
  async rotateTableToken(input: {
    tableId: string;
    userId?: string;
  }): Promise<
    { ok: true; qrToken: string } | { ok: false; error: "not_found" }
  > {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, input.tableId))
      .limit(1);
    const table = rows[0];
    if (!table || table.archivedAt !== null) {
      return { ok: false, error: "not_found" };
    }

    const token = qrToken();
    await this.db
      .update(schema.tables)
      .set({ qrToken: token, tokenRotatedAt: Date.now() })
      .where(eq(schema.tables.id, input.tableId));

    await this.audit(
      "table.token_rotated",
      JSON.stringify({ tableId: table.id, label: table.label }),
      input.userId,
    );
    return { ok: true, qrToken: token };
  }

  /**
   * Take a table off the floor plan without destroying its history.
   *
   * Refuses while a bill is open. Tidying the floor plan mid-service must
   * never be able to strand a table that is still eating.
   */
  async archiveTable(input: {
    tableId: string;
    userId?: string;
  }): Promise<
    | { ok: true }
    | { ok: false; error: "not_found" | "open_session"; detail?: string }
  > {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, input.tableId))
      .limit(1);
    const table = rows[0];
    if (!table || table.archivedAt !== null) {
      return { ok: false, error: "not_found" };
    }

    const open = await this.db
      .select()
      .from(schema.tableSessions)
      .where(
        and(
          eq(schema.tableSessions.tableId, table.id),
          inArray(schema.tableSessions.status, ["open", "bill_requested"]),
        ),
      )
      .limit(1);

    if (open[0]) {
      return { ok: false, error: "open_session", detail: open[0].id };
    }

    await this.db
      .update(schema.tables)
      .set({ archivedAt: Date.now(), status: "empty" })
      .where(eq(schema.tables.id, table.id));

    await this.audit(
      "table.archived",
      JSON.stringify({ tableId: table.id, label: table.label }),
      input.userId,
    );
    return { ok: true };
  }

  async restoreTable(input: {
    tableId: string;
    userId?: string;
  }): Promise<
    | { ok: true }
    | { ok: false; error: "not_found" | "label_taken"; detail?: string }
  > {
    const rows = await this.db
      .select()
      .from(schema.tables)
      .where(eq(schema.tables.id, input.tableId))
      .limit(1);
    const table = rows[0];
    if (!table || table.archivedAt === null) {
      return { ok: false, error: "not_found" };
    }
    // Its old label may have been reused while it was away.
    if (await this.labelTaken(table.label, table.id)) {
      return { ok: false, error: "label_taken", detail: table.label };
    }

    await this.db
      .update(schema.tables)
      .set({ archivedAt: null })
      .where(eq(schema.tables.id, table.id));
    await this.audit(
      "table.restored",
      JSON.stringify({ tableId: table.id }),
      input.userId,
    );
    return { ok: true };
  }

  async createZone(input: {
    nameMs: string;
    nameEn: string;
    sortOrder?: number;
  }): Promise<{ id: string }> {
    const zoneId = id("zon");
    await this.db.insert(schema.zones).values({
      id: zoneId,
      nameMs: input.nameMs,
      nameEn: input.nameEn,
      sortOrder: input.sortOrder ?? 0,
    });
    return { id: zoneId };
  }

  async updateZone(input: {
    zoneId: string;
    nameMs?: string;
    nameEn?: string;
    sortOrder?: number;
  }): Promise<{ ok: boolean }> {
    await this.db
      .update(schema.zones)
      .set({
        ...(input.nameMs !== undefined ? { nameMs: input.nameMs } : {}),
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
      })
      .where(eq(schema.zones.id, input.zoneId));
    return { ok: true };
  }

  /** Deleting a zone un-groups its tables rather than removing them. */
  async deleteZone(zoneId: string): Promise<{ ok: boolean }> {
    await this.db
      .update(schema.tables)
      .set({ zoneId: null })
      .where(eq(schema.tables.zoneId, zoneId));
    await this.db.delete(schema.zones).where(eq(schema.zones.id, zoneId));
    return { ok: true };
  }

  async getSettings() {
    const rows = await this.db.select().from(schema.settings).limit(1);
    return (
      rows[0] ?? {
        id: 1,
        outletName: null,
        wifiSsid: null,
        wifiPassword: null,
        localOrderUrl: null,
        menuVersion: 1,
        updatedAt: 0,
      }
    );
  }

  async updateSettings(input: {
    outletName?: string | null;
    wifiSsid?: string | null;
    wifiPassword?: string | null;
    localOrderUrl?: string | null;
  }): Promise<{ ok: boolean }> {
    await this.db
      .update(schema.settings)
      .set({
        ...(input.outletName !== undefined
          ? { outletName: input.outletName }
          : {}),
        ...(input.wifiSsid !== undefined ? { wifiSsid: input.wifiSsid } : {}),
        ...(input.wifiPassword !== undefined
          ? { wifiPassword: input.wifiPassword }
          : {}),
        ...(input.localOrderUrl !== undefined
          ? { localOrderUrl: input.localOrderUrl }
          : {}),
        updatedAt: Date.now(),
      })
      .where(eq(schema.settings.id, 1));
    return { ok: true };
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

    const table = input.tableId
      ? await this.resolveTableById(input.tableId)
      : input.qrToken
        ? await this.resolveTable(input.qrToken)
        : null;
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

    // A replayed order keeps the time the till actually took it, so the
    // daily record puts last night's takings on last night.
    const now = input.placedAt ?? Date.now();

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

    // Option definitions, loaded from our own database. This is the whole
    // point: the price of "tambah telur" is the restaurant's to decide, so it
    // is read here rather than believed from the request body.
    const groupRows = await this.db
      .select()
      .from(schema.modifierGroups)
      .where(inArray(schema.modifierGroups.menuItemId, menuIds));
    const optionRows = groupRows.length
      ? await this.db
          .select()
          .from(schema.modifierOptions)
          .where(
            inArray(
              schema.modifierOptions.groupId,
              groupRows.map((g) => g.id),
            ),
          )
      : [];

    const groupById = new Map(groupRows.map((g) => [g.id, g]));
    const optionById = new Map(optionRows.map((o) => [o.id, o]));
    const groupsByItem = new Map<string, typeof groupRows>();
    for (const group of groupRows) {
      const list = groupsByItem.get(group.menuItemId) ?? [];
      list.push(group);
      groupsByItem.set(group.menuItemId, list);
    }

    const orderId = id("ord");
    let totalSen = 0;
    const itemRows: (typeof schema.orderItems.$inferInsert)[] = [];

    for (const line of input.lines) {
      const item = menu.get(line.menuItemId);
      if (!item) {
        return { ok: false, error: "unknown_item", detail: line.menuItemId };
      }
      // 86-ing: an item marked habis stops being orderable immediately, even
      // for a phone already sitting on the menu page. A replayed order is
      // exempt — see PlaceOrderInput.replay.
      if (item.isAvailable === 0 && input.replay !== true) {
        return { ok: false, error: "unavailable", detail: item.nameMs };
      }

      // A `modifiers` field carrying its own labels/prices is the old,
      // client-priced shape. Only a tampered or badly outdated client sends
      // it; refuse loudly rather than silently dropping what it asked for.
      if ("modifiers" in (line as unknown as Record<string, unknown>)) {
        return {
          ok: false,
          error: "unknown_option",
          detail: "send modifierOptionIds; prices are not accepted from clients",
        };
      }

      // Resolve every chosen option against this item's own groups.
      const chosenIds = line.modifierOptionIds ?? [];
      const modifiers: Modifier[] = [];
      const chosenPerGroup = new Map<string, number>();

      for (const optionId of chosenIds) {
        const option = optionById.get(optionId);
        const group = option ? groupById.get(option.groupId) : undefined;
        // An option belonging to a different dish is as invalid as one that
        // does not exist — otherwise a cheap dish could borrow another's
        // discounted extras.
        if (!option || !group || group.menuItemId !== item.id) {
          return { ok: false, error: "unknown_option", detail: optionId };
        }
        chosenPerGroup.set(
          group.id,
          (chosenPerGroup.get(group.id) ?? 0) + 1,
        );
        modifiers.push({
          label: option.labelMs,
          priceDeltaSen: option.priceDeltaSen,
        });
      }

      for (const group of groupsByItem.get(item.id) ?? []) {
        const count = chosenPerGroup.get(group.id) ?? 0;
        if (count < group.minSelect) {
          return { ok: false, error: "option_required", detail: group.nameMs };
        }
        if (count > group.maxSelect) {
          return {
            ok: false,
            error: "too_many_options",
            detail: group.nameMs,
          };
        }
      }

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
        // The resolved snapshot: label and price as they were tonight.
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
    // 9 columns per row. A single family table ordering a dozen dishes would
    // otherwise blow the 100 bound-parameter cap and fail the whole order.
    for (const batch of batchForSql(itemRows, 9)) {
      await this.db.insert(schema.orderItems).values(batch);
    }

    // The append-only sync spine.
    await this.db.insert(schema.opLog).values({
      clientUlid,
      deviceId: input.deviceId ?? null,
      kind: "order.placed",
      payload: JSON.stringify({ orderId, sessionId: session.id, totalSen }),
      appliedAt: now,
    });

    if (input.replay === true) {
      await this.audit(
        "order.replayed",
        JSON.stringify({ orderId, clientUlid, placedAt: now, totalSen }),
      );
      // The till's number and the server's number should agree. When they do
      // not, someone edited a price during the outage — record it rather than
      // let it surface as an unexplained few ringgit in the month's accounts.
      if (
        input.expectedTotalSen !== undefined &&
        input.expectedTotalSen !== totalSen
      ) {
        await this.audit(
          "order.price_divergence",
          JSON.stringify({
            orderId,
            tillTotalSen: input.expectedTotalSen,
            serverTotalSen: totalSen,
          }),
        );
      }
    }

    // Fan the order out to its stations. Lines are grouped by the station
    // their menu category routes to, so a mixed order becomes one docket for
    // the kitchen and one for the drinks counter — each carrying only its own
    // lines, with modifiers and notes intact.
    //
    // Unless the tablet already did it. It is the print agent for its own
    // restaurant, so for an order it took itself the queue would only hand the
    // job back to the device it came from.
    if (input.printedLocally === true) {
      await this.audit(
        "order.printed_by_device",
        JSON.stringify({ orderId, deviceId: input.deviceId ?? null }),
      );
    } else {
      await this.queuePrintJobs({
        orderId,
        tableLabel: table.label,
        placedAt: now,
        lines: itemRows.map((r) => ({
          menuItemId: r.menuItemId,
          qty: r.qty,
          name: r.nameMs,
          modifiers: (JSON.parse(r.modifiers ?? "[]") as Modifier[]).map(
            (m) => m.label,
          ),
          notes: r.notes ?? null,
        })),
      });
    }

    await this.db
      .update(schema.tables)
      .set({ status: "ordering" })
      .where(eq(schema.tables.id, table.id));

    // The write and the announcement are one operation: every connected till
    // hears about this order in the same call that stored it.
    broadcast(this.ctx, {
      type: "order.placed",
      orderId,
      tableId: table.id,
      tableLabel: table.label,
      sessionId: session.id,
      placedAt: now,
      source: input.source ?? "qr",
      totalSen,
      lines: itemRows.map(
        (r): TicketLine => ({
          qty: r.qty,
          nameMs: r.nameMs,
          nameEn: r.nameEn,
          modifiers: JSON.parse(r.modifiers ?? "[]") as Modifier[],
          notes: r.notes ?? null,
        }),
      ),
    });

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
      sessionId: string;
      tableId: string;
      tableLabel: string;
      placedAt: number;
      status: string;
      source: string;
      totalSen: Sen;
      lines: TicketLine[];
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
          sessionId: o.sessionId,
          tableId: sessionRow?.tableId ?? "?",
          tableLabel: tableRow?.label ?? "?",
          placedAt: o.placedAt,
          status: o.status,
          source: o.source,
          totalSen,
          lines: items
            .filter((li) => li.orderId === o.id)
            .map(
              (li): TicketLine => ({
                qty: li.qty,
                nameMs: li.nameMs,
                nameEn: li.nameEn,
                modifiers: JSON.parse(li.modifiers) as Modifier[],
                notes: li.notes,
              }),
            ),
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

  /* ---------------------------------------------------------------- *
   * Printing
   *
   * The Worker renders ESC/POS; the agent only moves bytes to a socket and
   * says what happened. Keeping layout server-side means fixing a docket is a
   * deploy, not a visit to a restaurant.
   * ---------------------------------------------------------------- */

  async listStations() {
    const rows = await this.db.select().from(schema.printStations);
    return rows.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** Which menu category prints where. */
  async listStationRoutes() {
    return this.db.select().from(schema.stationRoutes);
  }

  /**
   * Group an order's lines by station and queue one docket per station.
   *
   * A category with no route falls back to the default station: a newly added
   * category must never silently fail to reach a kitchen.
   */
  private async queuePrintJobs(input: {
    orderId: string;
    tableLabel: string;
    placedAt: number;
    lines: {
      menuItemId: string;
      qty: number;
      name: string;
      modifiers: string[];
      notes: string | null;
    }[];
    reprint?: boolean;
  }): Promise<string[]> {
    const stations = await this.listStations();
    if (stations.filter((s) => s.enabled === 1).length === 0) return [];

    const routes = await this.db.select().from(schema.stationRoutes);

    const menuIds = input.lines.map((l) => l.menuItemId);
    const menuRows = menuIds.length
      ? await this.db
          .select()
          .from(schema.menuItems)
          .where(inArray(schema.menuItems.id, menuIds))
      : [];
    const categoryByItem = new Map(menuRows.map((m) => [m.id, m.categoryId]));

    // The grouping rule itself lives in @suriani/core, because the tablet
    // applies it too when it prints a docket with the line down. A cook
    // cannot tell which machine produced a slip, so the two must not drift.
    const grouped = groupLinesByStation(input.lines, {
      stations,
      routes,
      categoryByItem,
      menuItemIdOf: (l) => l.menuItemId,
    });

    const created: string[] = [];
    for (const { station, lines } of grouped) {
      const jobId = id("pj");
      await this.db.insert(schema.printJobs).values({
        id: jobId,
        orderId: input.orderId,
        stationId: station.id,
        target: station.target,
        payload: JSON.stringify({
          kind: "kitchen",
          stationName: station.name,
          tableLabel: input.tableLabel,
          orderCode: `#${input.orderId.slice(-5).toUpperCase()}`,
          placedAt: input.placedAt,
          reprint: input.reprint === true,
          lines,
        }),
        status: "queued",
        attempts: 0,
        nextAttemptAt: 0,
        firstQueuedAt: Date.now(),
        createdAt: Date.now(),
      });
      created.push(jobId);
    }

    broadcast(this.ctx, { type: "print.queued", orderId: input.orderId });
    return created;
  }

  /**
   * Hand an agent some work, leased.
   *
   * The lease is the safety property: a claimed job is not removed, so an
   * agent that dies mid-print releases it by expiry and another attempt
   * happens. Deleting on claim would lose the docket in silence.
   */
  async claimPrintJobs(input: { deviceId: string; limit?: number }) {
    const now = Date.now();
    const limit = Math.min(input.limit ?? 5, 20);

    const all = await this.db.select().from(schema.printJobs);
    const claimable = all
      .filter(
        (j) =>
          (j.status === "queued" &&
            j.nextAttemptAt <= now &&
            (j.leaseUntil === null || j.leaseUntil < now)) ||
          // A lease that expired without an ack: the agent died mid-print.
          (j.status === "claimed" && (j.leaseUntil ?? 0) < now),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    const outletName =
      (await this.getSettings()).outletName ?? "Restoran Suriani";

    const leaseUntil = now + 30_000;
    const out: {
      id: string;
      target: string;
      stationId: string | null;
      attempts: number;
      escposBase64: string;
    }[] = [];

    for (const job of claimable) {
      await this.db
        .update(schema.printJobs)
        .set({ status: "claimed", leaseUntil })
        .where(eq(schema.printJobs.id, job.id));
      out.push({
        id: job.id,
        target: job.target,
        stationId: job.stationId,
        attempts: job.attempts,
        escposBase64: renderJob(job.payload, outletName),
      });
    }

    if (out.length) {
      await this.ctx.storage.put(`agent_seen_${input.deviceId}`, now);
    }
    return out;
  }

  /**
   * The agent reports back.
   *
   * Backoff on failure, then `failed` — which the till shows as a red banner.
   * A silently failed docket is a table that never gets its food.
   */
  async ackPrintJob(input: {
    jobId: string;
    ok: boolean;
    transport?: string;
    error?: string;
  }): Promise<{ ok: boolean; status: string }> {
    const rows = await this.db
      .select()
      .from(schema.printJobs)
      .where(eq(schema.printJobs.id, input.jobId))
      .limit(1);
    const job = rows[0];
    if (!job) return { ok: false, status: "unknown" };

    // Acking a finished job is a no-op, not a resurrection: a retrying agent
    // must not be able to double-count attempts or reopen a printed docket.
    if (job.status === "printed" || job.status === "failed") {
      return { ok: true, status: job.status };
    }

    if (input.ok) {
      await this.db
        .update(schema.printJobs)
        .set({
          status: "printed",
          transport: input.transport ?? null,
          leaseUntil: null,
          attempts: job.attempts + 1,
          lastError: null,
        })
        .where(eq(schema.printJobs.id, job.id));
      broadcast(this.ctx, {
        type: "print.printed",
        jobId: job.id,
        orderId: job.orderId,
      });
      return { ok: true, status: "printed" };
    }

    const attempts = job.attempts + 1;
    const backoff = [2_000, 5_000, 15_000, 45_000];
    const giveUp = attempts > backoff.length;

    await this.db
      .update(schema.printJobs)
      .set({
        status: giveUp ? "failed" : "queued",
        attempts,
        lastError: input.error ?? "unknown",
        leaseUntil: null,
        nextAttemptAt: giveUp
          ? 0
          : Date.now() + (backoff[attempts - 1] ?? 45_000),
      })
      .where(eq(schema.printJobs.id, job.id));

    if (giveUp) {
      const payload = JSON.parse(job.payload) as { tableLabel?: string };
      broadcast(this.ctx, {
        type: "print.failed",
        jobId: job.id,
        orderId: job.orderId,
        tableLabel: payload.tableLabel ?? "?",
        error: input.error ?? "unknown",
      });
    }
    return { ok: true, status: giveUp ? "failed" : "queued" };
  }

  /** Re-queue a docket, marked so nobody cooks it twice. */
  async reprintJob(input: {
    jobId: string;
    userId?: string;
  }): Promise<{ ok: boolean }> {
    const rows = await this.db
      .select()
      .from(schema.printJobs)
      .where(eq(schema.printJobs.id, input.jobId))
      .limit(1);
    const job = rows[0];
    if (!job) return { ok: false };

    // Re-queued from the stored snapshot, so a reprint of last week's docket
    // is identical even after menu prices changed.
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    payload.reprint = true;

    await this.db.insert(schema.printJobs).values({
      id: id("pj"),
      orderId: job.orderId,
      stationId: job.stationId,
      target: job.target,
      payload: JSON.stringify(payload),
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      firstQueuedAt: Date.now(),
      createdAt: Date.now(),
    });
    await this.audit(
      "print.reprint",
      JSON.stringify({ jobId: job.id }),
      input.userId,
    );
    broadcast(this.ctx, { type: "print.queued", orderId: job.orderId });
    return { ok: true };
  }

  /**
   * Printer health for the till's pill.
   *
   * `stalled` catches the case retries cannot: the agent is simply gone, so
   * nothing is failing — jobs just sit there. Silence is the dangerous state.
   */
  async printHealth(): Promise<{
    queued: number;
    failed: number;
    stalled: boolean;
    oldestQueuedMs: number | null;
    recent: {
      id: string;
      status: string;
      target: string;
      tableLabel: string;
      attempts: number;
      lastError: string | null;
    }[];
  }> {
    const now = Date.now();
    const jobs = await this.db.select().from(schema.printJobs);
    const queued = jobs.filter(
      (j) => j.status === "queued" || j.status === "claimed",
    );
    const failed = jobs.filter((j) => j.status === "failed");

    const oldest = queued.reduce<number | null>((min, j) => {
      const age = now - (j.firstQueuedAt ?? j.createdAt);
      return min === null || age > min ? age : min;
    }, null);

    return {
      queued: queued.length,
      failed: failed.length,
      stalled: oldest !== null && oldest > 90_000,
      oldestQueuedMs: oldest,
      recent: [...failed, ...queued]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((j) => ({
          id: j.id,
          status: j.status,
          target: j.target,
          tableLabel:
            (JSON.parse(j.payload) as { tableLabel?: string }).tableLabel ?? "?",
          attempts: j.attempts,
          lastError: j.lastError,
        })),
    };
  }

  /* ---------------------------------------------------------------- *
   * Service lifecycle — the till's verbs
   * ---------------------------------------------------------------- */

  async markOrderServed(input: {
    orderId: string;
    userId?: string;
  }): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
    const rows = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, input.orderId))
      .limit(1);
    const order = rows[0];
    if (!order || order.status === "voided") {
      return { ok: false, error: "not_found" };
    }

    await this.db
      .update(schema.orders)
      .set({ status: "served" })
      .where(eq(schema.orders.id, order.id));

    const session = (
      await this.db
        .select()
        .from(schema.tableSessions)
        .where(eq(schema.tableSessions.id, order.sessionId))
        .limit(1)
    )[0];

    if (session) {
      await this.db
        .update(schema.tables)
        .set({ status: "eating" })
        .where(
          and(
            eq(schema.tables.id, session.tableId),
            eq(schema.tables.status, "ordering"),
          ),
        );
      broadcast(this.ctx, {
        type: "order.served",
        orderId: order.id,
        tableId: session.tableId,
      });
    }
    return { ok: true };
  }

  /** Customer taps "Minta Bil". Token-authed; lights the till amber. */
  async requestBill(
    token: string,
  ): Promise<
    { ok: true; totalSen: Sen } | { ok: false; error: "unknown_table" | "no_open_bill" }
  > {
    const table = await this.resolveTable(token);
    if (!table) return { ok: false, error: "unknown_table" };

    const session = (
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
    if (!session) return { ok: false, error: "no_open_bill" };

    await this.db
      .update(schema.tableSessions)
      .set({ status: "bill_requested" })
      .where(eq(schema.tableSessions.id, session.id));
    await this.db
      .update(schema.tables)
      .set({ status: "bill_requested" })
      .where(eq(schema.tables.id, table.id));

    const floor = await this.getFloor();
    const totalSen =
      floor.find((t) => t.id === table.id)?.session?.totalSen ?? 0;

    broadcast(this.ctx, {
      type: "bill.requested",
      tableId: table.id,
      sessionId: session.id,
      totalSen,
    });
    return { ok: true, totalSen };
  }

  /**
   * Customer taps "Panggil Pelayan".
   *
   * Throttled per table: repeated taps inside a minute coalesce, so an
   * impatient table cannot turn the till into an alarm clock. The throttle
   * clock lives in durable storage, surviving hibernation.
   */
  async callWaiter(
    token: string,
  ): Promise<
    | { ok: true; coalesced: boolean }
    | { ok: false; error: "unknown_table" }
  > {
    const table = await this.resolveTable(token);
    if (!table) return { ok: false, error: "unknown_table" };

    const key = `waiter_called_${table.id}`;
    const last = (await this.ctx.storage.get<number>(key)) ?? 0;
    const now = Date.now();
    if (now - last < 60_000) return { ok: true, coalesced: true };

    await this.ctx.storage.put(key, now);
    broadcast(this.ctx, {
      type: "waiter.called",
      tableId: table.id,
      tableLabel: table.label,
    });
    return { ok: true, coalesced: false };
  }

  /** The bill sheet: one table's open session with every order and line. */
  async getSessionDetail(tableId: string) {
    const table = await this.resolveTableById(tableId);
    if (!table) return null;

    const session = (
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
    if (!session) return { table: { id: table.id, label: table.label }, session: null };

    const orders = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.sessionId, session.id));
    const live = orders.filter((o) => o.status !== "voided");
    const items = live.length
      ? await this.db
          .select()
          .from(schema.orderItems)
          .where(
            inArray(
              schema.orderItems.orderId,
              live.map((o) => o.id),
            ),
          )
      : [];

    let totalSen = 0;
    let itemCount = 0;
    const detail = live
      .sort((a, b) => a.placedAt - b.placedAt)
      .map((o) => {
        const lines = items
          .filter((li) => li.orderId === o.id)
          .map((li) => {
            const modifiers = JSON.parse(li.modifiers) as Modifier[];
            const lineSen = lineTotalSen(li.unitPriceSen, li.qty, modifiers);
            totalSen += lineSen;
            itemCount += li.qty;
            return {
              nameMs: li.nameMs,
              nameEn: li.nameEn,
              qty: li.qty,
              lineSen,
              modifiers,
              notes: li.notes,
            };
          });
        return { id: o.id, placedAt: o.placedAt, status: o.status, source: o.source, lines };
      });

    return {
      table: { id: table.id, label: table.label },
      session: {
        id: session.id,
        openedAt: session.openedAt,
        status: session.status,
        totalSen,
        /** How many plates are on the table — the counter asks this first. */
        itemCount,
        orders: detail,
      },
    };
  }

  /**
   * Print the bill for an open table.
   *
   * Rendered from the session as it stands, at the counter station. `method`
   * is left unset here because nothing has been paid yet: the customer asked
   * for the bill, and Phase 6 will call this again with a method once money
   * has actually changed hands.
   */
  async queueReceipt(input: {
    sessionId: string;
    method?: string;
    userId?: string;
  }): Promise<
    | { ok: true; jobId: string; totalSen: Sen; itemCount: number }
    | { ok: false; error: "not_found" | "no_station" }
  > {
    const session = (
      await this.db
        .select()
        .from(schema.tableSessions)
        .where(eq(schema.tableSessions.id, input.sessionId))
        .limit(1)
    )[0];
    if (!session) return { ok: false, error: "not_found" };

    const detail = await this.getSessionDetail(session.tableId);
    if (!detail?.session || detail.session.id !== session.id) {
      return { ok: false, error: "not_found" };
    }

    const stations = (await this.listStations()).filter((s) => s.enabled === 1);
    // Counter first, then the default station: a restaurant with one printer
    // still gets its bill rather than nothing at all.
    const station =
      stations.find((s) => s.target === "counter") ??
      stations.find((s) => s.isDefault === 1) ??
      stations[0];
    if (!station) return { ok: false, error: "no_station" };

    const receiptLines: ReceiptLine[] = detail.session.orders.flatMap((o) =>
      o.lines.map((l) => ({
        qty: l.qty,
        name: l.nameMs,
        modifiers: l.modifiers.map((m) => ({
          label: m.label,
          priceDeltaSen: m.priceDeltaSen,
        })),
        lineSen: l.lineSen,
      })),
    );

    const jobId = id("pj");
    const now = Date.now();
    await this.db.insert(schema.printJobs).values({
      id: jobId,
      orderId: null,
      stationId: station.id,
      target: station.target,
      payload: JSON.stringify({
        kind: "receipt",
        tableLabel: detail.table.label,
        orderCode: `#${session.id.slice(-5).toUpperCase()}`,
        placedAt: now,
        receiptLines,
        totalSen: detail.session.totalSen,
        itemCount: detail.session.itemCount,
        ...(input.method ? { method: input.method } : {}),
      }),
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      firstQueuedAt: now,
      createdAt: now,
    });

    await this.audit(
      "receipt.printed",
      JSON.stringify({
        sessionId: session.id,
        totalSen: detail.session.totalSen,
      }),
      input.userId,
    );
    broadcast(this.ctx, { type: "print.queued", orderId: null });

    return {
      ok: true,
      jobId,
      totalSen: detail.session.totalSen,
      itemCount: detail.session.itemCount,
    };
  }

  /**
   * Close a bill and free the table.
   *
   * Phase 6 fronts this with payment recording; the primitive itself stays.
   * Closing without payment is audit-logged so nothing disappears quietly.
   */
  async closeSession(input: {
    sessionId: string;
    userId?: string;
  }): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
    const session = (
      await this.db
        .select()
        .from(schema.tableSessions)
        .where(eq(schema.tableSessions.id, input.sessionId))
        .limit(1)
    )[0];
    if (!session || session.status === "closed") {
      return { ok: false, error: "not_found" };
    }

    await this.db
      .update(schema.tableSessions)
      .set({ status: "closed", closedAt: Date.now() })
      .where(eq(schema.tableSessions.id, session.id));
    await this.db
      .update(schema.tables)
      .set({ status: "empty" })
      .where(eq(schema.tables.id, session.tableId));
    await this.audit(
      "session.closed",
      JSON.stringify({ sessionId: session.id, tableId: session.tableId }),
      input.userId,
    );
    broadcast(this.ctx, {
      type: "session.closed",
      tableId: session.tableId,
      sessionId: session.id,
    });
    return { ok: true };
  }

  /**
   * 86-ing. "Ayam habis" — one tap and the dish stops being orderable
   * everywhere: new orders are refused server-side immediately, tills hear it
   * on the socket, and phones notice the menuVersion bump on their next poll.
   */
  async setItemAvailability(input: {
    itemId: string;
    available: boolean;
    userId?: string;
  }): Promise<
    { ok: true; menuVersion: number } | { ok: false; error: "not_found" }
  > {
    const rows = await this.db
      .select()
      .from(schema.menuItems)
      .where(eq(schema.menuItems.id, input.itemId))
      .limit(1);
    if (!rows[0]) return { ok: false, error: "not_found" };

    await this.db
      .update(schema.menuItems)
      .set({ isAvailable: input.available ? 1 : 0 })
      .where(eq(schema.menuItems.id, input.itemId));

    const settings = await this.getSettings();
    const menuVersion = (settings.menuVersion ?? 1) + 1;
    await this.db
      .update(schema.settings)
      .set({ menuVersion, updatedAt: Date.now() })
      .where(eq(schema.settings.id, 1));

    await this.audit(
      "item.availability",
      JSON.stringify({ itemId: input.itemId, available: input.available }),
      input.userId,
    );
    broadcast(this.ctx, {
      type: "item.availability",
      itemId: input.itemId,
      available: input.available,
      menuVersion,
    });
    return { ok: true, menuVersion };
  }

  /**
   * The customer's status poll: cheap enough to call every ~12 seconds.
   * Carries menuVersion so an idle phone learns to refetch a changed menu.
   */
  async getStatus(token: string) {
    const table = await this.resolveTable(token);
    if (!table) return null;

    const settings = await this.getSettings();
    const detail = await this.getSessionDetail(table.id);
    return {
      menuVersion: settings.menuVersion ?? 1,
      table: { label: table.label, status: table.status },
      session: detail?.session
        ? {
            status: detail.session.status,
            totalSen: detail.session.totalSen,
            orders: detail.session.orders.map((o) => ({
              id: o.id,
              status: o.status,
              placedAt: o.placedAt,
              lines: o.lines.map((l) => ({
                nameMs: l.nameMs,
                nameEn: l.nameEn,
                qty: l.qty,
              })),
            })),
          }
        : null,
    };
  }

  /* ---------------------------------------------------------------- *
   * Sync
   *
   * A tablet that traded through an outage hands over its op log. This is the
   * one place the two halves of the product meet, and it holds because the
   * Durable Object is single-threaded: ops apply in the order they arrive,
   * one batch at a time, with nothing racing them.
   * ---------------------------------------------------------------- */

  /**
   * Apply a device's ops, in order, exactly once each.
   *
   * Three properties this has to have, and each one is a real failure it
   * prevents:
   *
   *  1. **Idempotent.** `op_log.client_ulid` is UNIQUE and every op is keyed
   *     by a ULID the device minted before its first attempt. A tablet that
   *     sends a batch, loses the reply and retries bills nobody twice.
   *
   *  2. **Ordered.** Applied in array order, so "serve order X" cannot land
   *     before "place order X" and 404.
   *
   *  3. **One bad op cannot block the queue.** An op that can never succeed
   *     is answered `rejected`, so the device drops it and keeps going.
   *     Retrying it forever would wedge every order queued behind it — which
   *     is how an outage turns into a lost evening.
   */
  async applyOps(input: {
    ops: SyncOp[];
    userId?: string;
  }): Promise<{ results: SyncOpResult[] }> {
    const results: SyncOpResult[] = [];

    for (const op of input.ops) {
      if (!op?.clientUlid || !op.body?.kind) {
        results.push({
          clientUlid: op?.clientUlid ?? "",
          status: "rejected",
          error: "malformed_op",
        });
        continue;
      }

      const seen = (
        await this.db
          .select()
          .from(schema.opLog)
          .where(eq(schema.opLog.clientUlid, op.clientUlid))
          .limit(1)
      )[0];
      if (seen) {
        const payload = JSON.parse(seen.payload) as { orderId?: string };
        results.push({
          clientUlid: op.clientUlid,
          status: "duplicate",
          orderId: payload.orderId,
        });
        continue;
      }

      results.push(await this.applyOne(op, input.userId));
    }

    return { results };
  }

  /**
   * How old an op has to be before it counts as replayed rather than live.
   *
   * The till writes every action to its outbox and sends it immediately, so a
   * normal counter order reaches here within a second or two. Anything much
   * older sat in the outbox through an outage.
   *
   * This matters because a replay bypasses the 86 check, and the *server* has
   * to be the one deciding that — not a flag the client sets. Otherwise the
   * till could turn off a server-side rule by asking nicely, which is exactly
   * the shape of the price-trust bug Phase 2b closed.
   *
   * It fails safe: a device whose clock runs fast looks live and gets the
   * stricter path.
   */
  private static readonly REPLAY_AFTER_MS = 60_000;

  private async applyOne(op: SyncOp, userId?: string): Promise<SyncOpResult> {
    const body = op.body;
    const age = Date.now() - op.at;
    const replay = age > OutletDO.REPLAY_AFTER_MS;

    switch (body.kind) {
      case "order.place": {
        const placed = await this.placeOrder({
          tableId: body.tableId,
          lines: body.lines,
          clientUlid: op.clientUlid,
          source: "counter",
          deviceId: op.deviceId,
          replay,
          // Only a replay is trusted to say when it happened. A live op uses
          // server time, so a tablet with a slow clock cannot post today's
          // sales to yesterday.
          placedAt: replay ? op.at : undefined,
          expectedTotalSen: body.expectedTotalSen,
          // Not a rule the device is talking its way out of — it is reporting
          // a physical fact the server has no other way to learn: paper came
          // out of a printer in that restaurant. The device only sets it after
          // the print actually succeeded, so a failure falls back to the queue.
          printedLocally: body.printedLocally === true,
        });
        if (!placed.ok) {
          // unknown_table and unknown_item can never come good; the dish or
          // the table is gone. Answer rejected so the device stops trying.
          return {
            clientUlid: op.clientUlid,
            status: "rejected",
            error: placed.error,
          };
        }
        return {
          clientUlid: op.clientUlid,
          status: placed.order.duplicate ? "duplicate" : "applied",
          orderId: placed.order.orderId,
        };
      }

      case "order.serve": {
        const served = await this.markOrderServed({
          orderId: body.orderId,
          userId,
        });
        if (!served.ok) {
          return {
            clientUlid: op.clientUlid,
            status: "rejected",
            error: "not_found",
          };
        }
        await this.recordOp(op, { orderId: body.orderId });
        return { clientUlid: op.clientUlid, status: "applied" };
      }

      case "session.close": {
        const closed = await this.closeSession({
          sessionId: body.sessionId,
          userId,
        });
        // A bill someone else already closed is not a failure — it is the
        // outcome this op wanted. Treat it as done, not as an error.
        await this.recordOp(op, { sessionId: body.sessionId });
        return {
          clientUlid: op.clientUlid,
          status: closed.ok ? "applied" : "duplicate",
        };
      }

      case "item.availability": {
        // The only genuinely mutable thing a device can change, so it is the
        // only place a conflict is possible. Last write wins and the server
        // is authoritative — that is the entire conflict model.
        const flipped = await this.setItemAvailability({
          itemId: body.itemId,
          available: body.available,
          userId,
        });
        if (!flipped.ok) {
          return {
            clientUlid: op.clientUlid,
            status: "rejected",
            error: "not_found",
          };
        }
        await this.recordOp(op, { itemId: body.itemId });
        return { clientUlid: op.clientUlid, status: "applied" };
      }

      default: {
        return {
          clientUlid: op.clientUlid,
          status: "rejected",
          error: "unknown_kind",
        };
      }
    }
  }

  /**
   * Write the op to the log so a replay is recognised.
   *
   * `placeOrder` writes its own entry; everything else records here.
   */
  private async recordOp(op: SyncOp, payload: unknown): Promise<void> {
    await this.db
      .insert(schema.opLog)
      .values({
        clientUlid: op.clientUlid,
        deviceId: op.deviceId ?? null,
        kind: op.body.kind,
        payload: JSON.stringify(payload),
        appliedAt: Date.now(),
      })
      .onConflictDoNothing();
  }

  /* ---------------------------------------------------------------- *
   * The daily record
   *
   * A day is derived from the orders themselves rather than from a rollup
   * table written at closing time. That costs a range scan, and buys three
   * things worth more than the scan: the number is right retroactively, it
   * cannot drift from the orders it claims to summarise, and there is no
   * nightly job whose silent failure leaves a hole in the books.
   *
   * Days are bucketed in the outlet's own timezone. An order at 8pm belongs
   * to tonight's takings, not to tomorrow's, and UTC would put it there.
   * ---------------------------------------------------------------- */

  /** Longest window a single request may ask for. */
  private static readonly MAX_REPORT_DAYS = 92;

  /** YYYY-MM-DD in the restaurant's own timezone. */
  private static localDate(at: number, timeZone: string): string {
    // en-CA formats as YYYY-MM-DD, which sorts correctly as a string.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  }

  private static localHour(at: number, timeZone: string): number {
    return Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        hour12: false,
      }).format(new Date(at)),
    );
  }

  /**
   * Live (non-voided) orders in a window, with their lines and money already
   * resolved. Every report below is a fold over this.
   */
  private async ordersSince(fromMs: number) {
    const rows = await this.db
      .select()
      .from(schema.orders)
      .where(gte(schema.orders.placedAt, fromMs));
    const live = rows.filter((o) => o.status !== "voided");
    if (live.length === 0) return [];

    const items: (typeof schema.orderItems.$inferSelect)[] = [];
    for (const batch of batchForSql(live, 1)) {
      items.push(
        ...(await this.db
          .select()
          .from(schema.orderItems)
          .where(
            inArray(
              schema.orderItems.orderId,
              batch.map((o) => o.id),
            ),
          )),
      );
    }

    const linesByOrder = new Map<string, typeof items>();
    for (const li of items) {
      const list = linesByOrder.get(li.orderId) ?? [];
      list.push(li);
      linesByOrder.set(li.orderId, list);
    }

    return live.map((o) => {
      const lines = (linesByOrder.get(o.id) ?? []).map((li) => ({
        menuItemId: li.menuItemId,
        nameMs: li.nameMs,
        nameEn: li.nameEn,
        qty: li.qty,
        lineSen: lineTotalSen(
          li.unitPriceSen,
          li.qty,
          JSON.parse(li.modifiers) as Modifier[],
        ),
      }));
      return {
        id: o.id,
        sessionId: o.sessionId,
        placedAt: o.placedAt,
        source: o.source,
        lines,
        totalSen: lines.reduce((sum, l) => sum + l.lineSen, 0),
      };
    });
  }

  /** One row per day, newest first. The owner's history screen. */
  async dailySales(input: { timeZone?: string; days?: number }): Promise<{
    days: {
      date: string;
      salesSen: Sen;
      orderCount: number;
      billCount: number;
      itemCount: number;
    }[];
  }> {
    const timeZone = input.timeZone ?? "Asia/Kuala_Lumpur";
    const days = Math.min(
      Math.max(input.days ?? 30, 1),
      OutletDO.MAX_REPORT_DAYS,
    );
    const orders = await this.ordersSince(Date.now() - days * 86_400_000);

    const byDate = new Map<
      string,
      {
        date: string;
        salesSen: Sen;
        orderCount: number;
        sessions: Set<string>;
        itemCount: number;
      }
    >();
    for (const o of orders) {
      const date = OutletDO.localDate(o.placedAt, timeZone);
      const day = byDate.get(date) ?? {
        date,
        salesSen: 0,
        orderCount: 0,
        sessions: new Set<string>(),
        itemCount: 0,
      };
      day.salesSen += o.totalSen;
      day.orderCount += 1;
      day.sessions.add(o.sessionId);
      day.itemCount += o.lines.reduce((sum, l) => sum + l.qty, 0);
      byDate.set(date, day);
    }

    return {
      days: [...byDate.values()]
        .map(({ sessions, ...rest }) => ({ ...rest, billCount: sessions.size }))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }

  /** One day opened up: where the money came from and when. */
  async daySummary(input: { date: string; timeZone?: string }): Promise<{
    date: string;
    salesSen: Sen;
    orderCount: number;
    billCount: number;
    itemCount: number;
    byHour: { hour: number; salesSen: Sen; orderCount: number }[];
    byCategory: { categoryId: string; nameMs: string; nameEn: string; salesSen: Sen; qty: number }[];
    byItem: { menuItemId: string; nameMs: string; nameEn: string; salesSen: Sen; qty: number }[];
  }> {
    const timeZone = input.timeZone ?? "Asia/Kuala_Lumpur";

    // A day anywhere on earth is inside a ±36h window around midnight UTC of
    // that calendar date, so scan wide and filter by the local date exactly.
    const anchor = Date.parse(`${input.date}T00:00:00Z`);
    const orders = (
      await this.ordersSince(Number.isNaN(anchor) ? Date.now() : anchor - 129_600_000)
    ).filter((o) => OutletDO.localDate(o.placedAt, timeZone) === input.date);

    const categoryOf = new Map<string, string>();
    const categoryNames = new Map<string, { nameMs: string; nameEn: string }>();
    if (orders.length) {
      for (const m of await this.db.select().from(schema.menuItems)) {
        categoryOf.set(m.id, m.categoryId);
      }
      for (const c of await this.db.select().from(schema.menuCategories)) {
        categoryNames.set(c.id, { nameMs: c.nameMs, nameEn: c.nameEn });
      }
    }

    const hours = new Map<number, { hour: number; salesSen: Sen; orderCount: number }>();
    const cats = new Map<
      string,
      { categoryId: string; nameMs: string; nameEn: string; salesSen: Sen; qty: number }
    >();
    const dishes = new Map<
      string,
      { menuItemId: string; nameMs: string; nameEn: string; salesSen: Sen; qty: number }
    >();
    const sessions = new Set<string>();
    let salesSen = 0;
    let itemCount = 0;

    for (const o of orders) {
      sessions.add(o.sessionId);
      salesSen += o.totalSen;

      const hour = OutletDO.localHour(o.placedAt, timeZone);
      const bucket = hours.get(hour) ?? { hour, salesSen: 0, orderCount: 0 };
      bucket.salesSen += o.totalSen;
      bucket.orderCount += 1;
      hours.set(hour, bucket);

      for (const l of o.lines) {
        itemCount += l.qty;

        const dish = dishes.get(l.menuItemId) ?? {
          menuItemId: l.menuItemId,
          nameMs: l.nameMs,
          nameEn: l.nameEn,
          salesSen: 0,
          qty: 0,
        };
        dish.salesSen += l.lineSen;
        dish.qty += l.qty;
        dishes.set(l.menuItemId, dish);

        // The dish's category *today*. A dish that has since been deleted
        // falls into "lain-lain" rather than vanishing from the total.
        const categoryId = categoryOf.get(l.menuItemId) ?? "lain";
        const names = categoryNames.get(categoryId) ?? {
          nameMs: "Lain-lain",
          nameEn: "Other",
        };
        const cat = cats.get(categoryId) ?? {
          categoryId,
          ...names,
          salesSen: 0,
          qty: 0,
        };
        cat.salesSen += l.lineSen;
        cat.qty += l.qty;
        cats.set(categoryId, cat);
      }
    }

    return {
      date: input.date,
      salesSen,
      orderCount: orders.length,
      billCount: sessions.size,
      itemCount,
      byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
      byCategory: [...cats.values()].sort((a, b) => b.salesSen - a.salesSen),
      byItem: [...dishes.values()].sort((a, b) => b.salesSen - a.salesSen),
    };
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
