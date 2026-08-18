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
import { id, qrToken, ulid } from "../lib/ids";
import { batchForSql } from "../lib/chunk";
import { lineTotalSen, type Modifier, type Sen } from "../lib/money";
import { renderKitchenTicket, type TicketLine as PrintLine } from "@suriani/escpos/templates";
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
function renderJob(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as {
    stationName?: string;
    tableLabel?: string;
    orderCode?: string;
    placedAt?: number;
    reprint?: boolean;
    lines?: PrintLine[];
  };

  const bytes = renderKitchenTicket({
    outletName: "Restoran Suriani",
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

  /** Install menu and tables. Used by the seed script and by tests. */
  async installSeed(input: {
    categories: SeedCategory[];
    items: SeedItem[];
    tables: SeedTable[];
    modifierGroups?: SeedModifierGroup[];
    stations?: {
      id: string;
      name: string;
      target: string;
      isDefault?: boolean;
      sortOrder?: number;
      categoryIds?: string[];
    }[];
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

    for (const g of input.modifierGroups ?? []) {
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
        .onConflictDoNothing();
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
          .onConflictDoNothing();
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
        .onConflictDoNothing();
      for (const categoryId of station.categoryIds ?? []) {
        await this.db
          .insert(schema.stationRoutes)
          .values({ stationId: station.id, categoryId })
          .onConflictDoNothing();
      }
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
    const groupsByItem = new Map<string, unknown[]>();
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
        wifiSsid: null,
        wifiPassword: null,
        localOrderUrl: null,
        menuVersion: 1,
        updatedAt: 0,
      }
    );
  }

  async updateSettings(input: {
    wifiSsid?: string | null;
    wifiPassword?: string | null;
    localOrderUrl?: string | null;
  }): Promise<{ ok: boolean }> {
    await this.db
      .update(schema.settings)
      .set({
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
      // for a phone already sitting on the menu page.
      if (item.isAvailable === 0) {
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

    // Fan the order out to its stations. Lines are grouped by the station
    // their menu category routes to, so a mixed order becomes one docket for
    // the kitchen and one for the drinks counter — each carrying only its own
    // lines, with modifiers and notes intact.
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
    const stations = (await this.listStations()).filter((s) => s.enabled === 1);
    if (stations.length === 0) return [];

    const fallback =
      stations.find((s) => s.isDefault === 1) ??
      stations.find((s) => s.target === "kitchen") ??
      stations[0]!;

    const routes = await this.db.select().from(schema.stationRoutes);
    const stationByCategory = new Map(
      routes.map((r) => [r.categoryId, r.stationId]),
    );

    const menuIds = input.lines.map((l) => l.menuItemId);
    const menuRows = menuIds.length
      ? await this.db
          .select()
          .from(schema.menuItems)
          .where(inArray(schema.menuItems.id, menuIds))
      : [];
    const categoryByItem = new Map(menuRows.map((m) => [m.id, m.categoryId]));

    const grouped = new Map<string, typeof input.lines>();
    for (const line of input.lines) {
      const categoryId = categoryByItem.get(line.menuItemId);
      const stationId =
        (categoryId ? stationByCategory.get(categoryId) : undefined) ??
        fallback.id;
      const list = grouped.get(stationId) ?? [];
      list.push(line);
      grouped.set(stationId, list);
    }

    const created: string[] = [];
    for (const [stationId, lines] of grouped) {
      const station = stations.find((s) => s.id === stationId) ?? fallback;
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
        escposBase64: renderJob(job.payload),
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
    const detail = live
      .sort((a, b) => a.placedAt - b.placedAt)
      .map((o) => {
        const lines = items
          .filter((li) => li.orderId === o.id)
          .map((li) => {
            const modifiers = JSON.parse(li.modifiers) as Modifier[];
            const lineSen = lineTotalSen(li.unitPriceSen, li.qty, modifiers);
            totalSen += lineSen;
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
        orders: detail,
      },
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
