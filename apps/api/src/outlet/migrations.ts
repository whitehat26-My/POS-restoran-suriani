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
