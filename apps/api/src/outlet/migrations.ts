/**
 * Per-outlet schema migrations.
 *
 * Every outlet is its own database, so there is no fleet-wide migration job to
 * run. Instead each Durable Object migrates itself the moment it next wakes,
 * inside `blockConcurrencyWhile`, so no request ever sees a half-migrated
 * schema. A branch that has been closed for a month migrates on its next order.
 *
 * Version is tracked in a `_schema_version` table rather than
 * `PRAGMA user_version`, because the same runner is reused on the cashier
 * tablet in Phase 5 and an explicit table is portable everywhere.
 *
 * Rules: append only, never edit a shipped migration, one statement per entry.
 */

export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE menu_categories (
        id TEXT PRIMARY KEY,
        name_ms TEXT NOT NULL,
        name_en TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE menu_items (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        name_ms TEXT NOT NULL,
        name_en TEXT NOT NULL,
        desc_ms TEXT,
        desc_en TEXT,
        price_sen INTEGER NOT NULL,
        photo_key TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        is_available INTEGER NOT NULL DEFAULT 1,
        stock_count INTEGER,
        prep_minutes INTEGER NOT NULL DEFAULT 10
      )`,
      `CREATE INDEX idx_items_category ON menu_items (category_id)`,
      `CREATE TABLE tables (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        qr_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'empty'
      )`,
      `CREATE TABLE table_sessions (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        status TEXT NOT NULL DEFAULT 'open'
      )`,
      `CREATE INDEX idx_sessions_table ON table_sessions (table_id, status)`,
      `CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        placed_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'qr',
        client_ulid TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'placed',
        void_reason TEXT
      )`,
      `CREATE INDEX idx_orders_session ON orders (session_id)`,
      `CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        menu_item_id TEXT NOT NULL,
        name_ms TEXT NOT NULL,
        name_en TEXT NOT NULL,
        qty INTEGER NOT NULL,
        unit_price_sen INTEGER NOT NULL,
        notes TEXT,
        modifiers TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE INDEX idx_order_items_order ON order_items (order_id)`,
      `CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        method TEXT NOT NULL,
        amount_sen INTEGER NOT NULL,
        reference TEXT,
        confirmed_by_user_id TEXT,
        paid_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_payments_session ON payments (session_id)`,
      `CREATE TABLE print_jobs (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        transport TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_print_jobs_status ON print_jobs (status)`,
      `CREATE TABLE op_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        client_ulid TEXT NOT NULL UNIQUE,
        device_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_op_log_applied ON op_log (applied_at)`,
      `CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      )`,
      `CREATE TABLE daily_closings (
        date TEXT PRIMARY KEY,
        opening_float_sen INTEGER NOT NULL DEFAULT 0,
        cash_counted_sen INTEGER,
        expected_sen INTEGER,
        variance_sen INTEGER,
        closed_by_user_id TEXT,
        closed_at INTEGER
      )`,
    ],
  },
  {
    // Configurable tables: a restaurant's floor is its own, not whatever the
    // seed script invented.
    //
    // This is the first migration that upgrades outlets already holding live
    // data, so every statement here is additive. ALTER TABLE ADD COLUMN with a
    // constant default is the only shape SQLite applies without rewriting the
    // table, which is what keeps existing rows intact.
    version: 2,
    statements: [
      `CREATE TABLE zones (
        id TEXT PRIMARY KEY,
        name_ms TEXT NOT NULL,
        name_en TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `ALTER TABLE tables ADD COLUMN zone_id TEXT`,
      `ALTER TABLE tables ADD COLUMN capacity INTEGER`,
      `ALTER TABLE tables ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`,
      // Soft delete. table_sessions.table_id points at these rows, so a real
      // DELETE would turn "Meja 05" into "?" in every historical bill.
      `ALTER TABLE tables ADD COLUMN archived_at INTEGER`,
      `ALTER TABLE tables ADD COLUMN token_rotated_at INTEGER`,
      `CREATE INDEX idx_tables_archived ON tables (archived_at)`,
      // Single-row outlet configuration. The guest WiFi details and the local
      // ordering URL are what the printed outage panel needs; until Phase 5b
      // sets them, the panel is simply omitted from the card.
      `CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        wifi_ssid TEXT,
        wifi_password TEXT,
        local_order_url TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`,
      `INSERT INTO settings (id, updated_at) VALUES (1, 0)`,
    ],
  },
  {
    // Modifier definitions — "tambah telur", "panas / ais", "kurang pedas".
    //
    // These exist so the server can price an option itself. Before this, a
    // modifier's price delta arrived in the request body, which meant the
    // customer chose it. Options live here; the phone sends only their ids.
    version: 3,
    statements: [
      `CREATE TABLE modifier_groups (
        id TEXT PRIMARY KEY,
        menu_item_id TEXT NOT NULL,
        name_ms TEXT NOT NULL,
        name_en TEXT NOT NULL,
        min_select INTEGER NOT NULL DEFAULT 0,
        max_select INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_modifier_groups_item ON modifier_groups (menu_item_id)`,
      `CREATE TABLE modifier_options (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        label_ms TEXT NOT NULL,
        label_en TEXT NOT NULL,
        price_delta_sen INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX idx_modifier_options_group ON modifier_options (group_id)`,
    ],
  },
];

/** Highest version this build knows how to migrate to. */
export const TARGET_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/**
 * Apply any migrations this database has not seen yet.
 *
 * Idempotent: running it twice is a no-op, which is what makes it safe to call
 * on every Durable Object wake-up.
 *
 * @returns the schema version after migrating
 */
export function runMigrations(sql: SqlStorage): number {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  );

  const rows = [...sql.exec<{ version: number }>(
    "SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1",
  )];
  let current = rows[0]?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const statement of migration.statements) {
      sql.exec(statement);
    }
    sql.exec(
      "INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)",
      migration.version,
      Date.now(),
    );
    current = migration.version;
  }

  return current;
}
