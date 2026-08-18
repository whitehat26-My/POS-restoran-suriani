/**
 * OUTLET DATA PLANE
 *
 * This schema lives inside each outlet's own Durable Object SQLite database.
 * One restaurant branch, one database. There is no `org_id` column anywhere in
 * this file, and that is the point: isolation is the storage boundary, not a
 * WHERE clause someone can forget.
 *
 * The same schema is reused on the cashier tablet in Phase 5, which is why it
 * stays plain SQLite with no Durable-Object-specific types.
 *
 * All money is integer sen. Never a float.
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const menuCategories = sqliteTable("menu_categories", {
  id: text("id").primaryKey(),
  nameMs: text("name_ms").notNull(),
  nameEn: text("name_en").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const menuItems = sqliteTable(
  "menu_items",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id").notNull(),
    nameMs: text("name_ms").notNull(),
    nameEn: text("name_en").notNull(),
    descMs: text("desc_ms"),
    descEn: text("desc_en"),
    priceSen: integer("price_sen").notNull(),
    photoKey: text("photo_key"),
    /** JSON array: ["halal","hot","best"] */
    tags: text("tags").notNull().default("[]"),
    isAvailable: integer("is_available").notNull().default(1),
    /** NULL means stock is not tracked for this item. */
    stockCount: integer("stock_count"),
    prepMinutes: integer("prep_minutes").notNull().default(10),
  },
  (t) => [index("idx_items_category").on(t.categoryId)],
);

/**
 * The options a dish offers — "Panas atau ais?", "Tambah telur".
 *
 * These live server-side for one reason above all: the price of an option is
 * the restaurant's to decide. The phone sends option ids and nothing else.
 */
export const modifierGroups = sqliteTable(
  "modifier_groups",
  {
    id: text("id").primaryKey(),
    menuItemId: text("menu_item_id").notNull(),
    nameMs: text("name_ms").notNull(),
    nameEn: text("name_en").notNull(),
    /** 1 forces a choice, e.g. hot or iced. */
    minSelect: integer("min_select").notNull().default(0),
    maxSelect: integer("max_select").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("idx_modifier_groups_item").on(t.menuItemId)],
);

export const modifierOptions = sqliteTable(
  "modifier_options",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    labelMs: text("label_ms").notNull(),
    labelEn: text("label_en").notNull(),
    /** Authoritative. Never taken from a request body. */
    priceDeltaSen: integer("price_delta_sen").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("idx_modifier_options_group").on(t.groupId)],
);

/** "Dalam", "Luar", "Tingkat 2" — groups the POS floor map. */
export const zones = sqliteTable("zones", {
  id: text("id").primaryKey(),
  nameMs: text("name_ms").notNull(),
  nameEn: text("name_en").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const tables = sqliteTable(
  "tables",
  {
    id: text("id").primaryKey(),
    /** "Meja 5" */
    label: text("label").notNull(),
    /**
     * A random secret, NOT the table number.
     *
     * If a QR encoded `?table=5`, anyone could type `?table=6` and send twenty
     * plates of chicken to a stranger's table. This is the single most common
     * way QR ordering fails in the real world.
     */
    qrToken: text("qr_token").notNull().unique(),
    /** empty | ordering | eating | bill_requested */
    status: text("status").notNull().default("empty"),
    zoneId: text("zone_id"),
    /** How many people it seats. Null when nobody has said. */
    capacity: integer("capacity"),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Soft delete.
     *
     * `table_sessions.table_id` points here, so a real DELETE would orphan
     * every historical bill this table ever had — "Meja 05" becomes "?" in
     * last month's reports. Archived rows stay readable for history and vanish
     * only from active listings.
     */
    archivedAt: integer("archived_at"),
    /** When the QR secret was last rotated, invalidating printed cards. */
    tokenRotatedAt: integer("token_rotated_at"),
  },
  (t) => [index("idx_tables_archived").on(t.archivedAt)],
);

/** Single-row outlet configuration. */
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  wifiSsid: text("wifi_ssid"),
  /** The guest network password, printed on the table card. Staff-only. */
  wifiPassword: text("wifi_password"),
  /** e.g. http://192.168.1.50:8080 — set once Phase 5b exists. */
  localOrderUrl: text("local_order_url"),
  /** Bumped on any menu change; phones refetch when they see it move. */
  menuVersion: integer("menu_version").notNull().default(1),
  updatedAt: integer("updated_at").notNull().default(0),
});

/** The open bill. One per table occupancy, shared by every phone at it. */
export const tableSessions = sqliteTable(
  "table_sessions",
  {
    id: text("id").primaryKey(),
    tableId: text("table_id").notNull(),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    /** open | bill_requested | paid | closed */
    status: text("status").notNull().default("open"),
  },
  (t) => [index("idx_sessions_table").on(t.tableId, t.status)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    placedAt: integer("placed_at").notNull(),
    /** qr | counter */
    source: text("source").notNull().default("qr"),
    /**
     * Client-generated ULID. The idempotency key that makes offline sync safe:
     * replaying an op log after an outage must never create a second order.
     */
    clientUlid: text("client_ulid").notNull().unique(),
    /** placed | printed | served | voided */
    status: text("status").notNull().default("placed"),
    voidReason: text("void_reason"),
  },
  (t) => [index("idx_orders_session").on(t.sessionId)],
);

export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    menuItemId: text("menu_item_id").notNull(),
    /** Denormalised so a printed ticket can be reproduced exactly. */
    nameMs: text("name_ms").notNull(),
    nameEn: text("name_en").notNull(),
    qty: integer("qty").notNull(),
    /**
     * A SNAPSHOT of the price at the moment of ordering.
     *
     * Raise the nasi lemak price at 3pm and this morning's bills must not
     * silently change. Systems that join to the live menu price instead
     * produce accounts that cannot be audited.
     */
    unitPriceSen: integer("unit_price_sen").notNull(),
    notes: text("notes"),
    /** JSON array of {label, priceDeltaSen} */
    modifiers: text("modifiers").notNull().default("[]"),
  },
  (t) => [index("idx_order_items_order").on(t.orderId)],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    /** cash | duitnow_qr | gateway */
    method: text("method").notNull(),
    amountSen: integer("amount_sen").notNull(),
    reference: text("reference"),
    confirmedByUserId: text("confirmed_by_user_id"),
    paidAt: integer("paid_at").notNull(),
  },
  (t) => [index("idx_payments_session").on(t.sessionId)],
);

/** Where a slip prints. Kitchen, drinks, counter — one row each. */
export const printStations = sqliteTable("print_stations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** kitchen | drinks | counter */
  target: text("target").notNull(),
  enabled: integer("enabled").notNull().default(1),
  /**
   * The fallback. A menu category with no route still prints here, so adding
   * a category can never silently stop food reaching the kitchen.
   */
  isDefault: integer("is_default").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** Which menu categories print at which station. */
export const stationRoutes = sqliteTable(
  "station_routes",
  {
    stationId: text("station_id").notNull(),
    categoryId: text("category_id").notNull(),
  },
  (t) => [index("idx_station_routes_category").on(t.categoryId)],
);

export const printJobs = sqliteTable(
  "print_jobs",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id"),
    stationId: text("station_id"),
    /**
     * Claimed jobs are leased, not removed. An agent that crashes mid-print
     * releases its job when the lease expires and another attempt happens.
     */
    leaseUntil: integer("lease_until"),
    /** When this job first entered the queue — drives the stalled alarm. */
    firstQueuedAt: integer("first_queued_at"),
    /** Backoff gate: not claimable before this. */
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    /** kitchen | counter */
    target: text("target").notNull(),
    payload: text("payload").notNull(),
    /** queued | printed | failed */
    status: text("status").notNull().default("queued"),
    /** lan | bluetooth — which transport actually succeeded. */
    transport: text("transport"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_print_jobs_status").on(t.status)],
);

/**
 * The sync spine. Append-only, never updated.
 *
 * Orders are facts rather than mutable state, so two devices can never
 * disagree about one. Voids and discounts are appended ops too.
 */
export const opLog = sqliteTable(
  "op_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    clientUlid: text("client_ulid").notNull().unique(),
    deviceId: text("device_id"),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    appliedAt: integer("applied_at").notNull(),
  },
  (t) => [index("idx_op_log_applied").on(t.appliedAt)],
);

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  action: text("action").notNull(),
  detail: text("detail"),
  at: integer("at").notNull(),
});

export const dailyClosings = sqliteTable("daily_closings", {
  date: text("date").primaryKey(),
  openingFloatSen: integer("opening_float_sen").notNull().default(0),
  cashCountedSen: integer("cash_counted_sen"),
  expectedSen: integer("expected_sen"),
  varianceSen: integer("variance_sen"),
  closedByUserId: text("closed_by_user_id"),
  closedAt: integer("closed_at"),
});

export type MenuItem = typeof menuItems.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type RestaurantTable = typeof tables.$inferSelect;
