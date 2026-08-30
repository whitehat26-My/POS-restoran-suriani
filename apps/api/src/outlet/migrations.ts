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
  {
    // menu_version lets customer phones notice a changed menu cheaply: the
    // status poll returns it, and a bump (an item 86'd, a price edit) tells
    // the phone to refetch. This is how "ayam habis" disappears from a phone
    // already sitting on the menu page, without any push infrastructure.
    version: 4,
    statements: [
      `ALTER TABLE settings ADD COLUMN menu_version INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // Print stations and the routing that decides which slip goes where.
    //
    // print_jobs gains a lease rather than being deleted on claim: an agent
    // that dies mid-print releases its job by expiry and another attempt
    // happens. Deleting on claim would lose the docket silently, which is
    // exactly the failure that must never be quiet.
    version: 5,
    statements: [
      `CREATE TABLE print_stations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE station_routes (
        station_id TEXT NOT NULL,
        category_id TEXT NOT NULL
      )`,
      `CREATE INDEX idx_station_routes_category ON station_routes (category_id)`,
      `ALTER TABLE print_jobs ADD COLUMN station_id TEXT`,
      `ALTER TABLE print_jobs ADD COLUMN lease_until INTEGER`,
      `ALTER TABLE print_jobs ADD COLUMN first_queued_at INTEGER`,
      `ALTER TABLE print_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX idx_print_jobs_claimable ON print_jobs (status, next_attempt_at)`,
    ],
  },
  {
    // Two small things the counter and the owner needed.
    //
    // `outlet_name` because the print renderer had the restaurant's name
    // hardcoded — which puts one tenant's brand on every other tenant's
    // paper, and a receipt makes that impossible to miss.
    //
    // The index because the daily record derives a day from the orders
    // themselves rather than from a rollup table. That is deliberate: a
    // derived day is right retroactively and cannot drift from the orders it
    // summarises, but it does mean reading a date range, so the range needs
    // an index to stay cheap as a year of service piles up.
    version: 6,
    statements: [
      `ALTER TABLE settings ADD COLUMN outlet_name TEXT`,
      `CREATE INDEX idx_orders_placed_at ON orders (placed_at)`,
    ],
  },
  {
    // Money.
    //
    // `payments` and `daily_closings` have existed since v1 and nothing has
    // ever written to either. This is the migration that makes them real, and
    // everything it adds is a lesson from how the rest of this system already
    // works:
    //
    // `client_ulid` because a payment is an append-only fact replayed from a
    // tablet's op log exactly like an order, and a lost reply on a flaky line
    // must not take the customer's money twice. UNIQUE is what enforces that,
    // not the application.
    //
    // `tendered_sen` / `change_sen` / `rounding_sen` because a receipt has to
    // show what was handed over and handed back, and because the 5-sen cash
    // rounding is an adjustment somebody will one day have to account for. A
    // total that has silently absorbed it cannot be reconciled.
    //
    // `voided_at` rather than a DELETE. A cashier who keys RM 100 instead of
    // RM 10 needs it reversed, and a deleted row hides that it ever happened —
    // the same rule that made archived tables a soft delete in v2.
    //
    // `receipt_no` monotonic per outlet, never reset. A number that restarts
    // each morning lets two receipts share an identifier, which is the one
    // thing a receipt number exists to prevent.
    version: 7,
    statements: [
      `ALTER TABLE payments ADD COLUMN client_ulid TEXT`,
      // A partial index: the column is nullable for rows written before this
      // existed, and SQLite treats every NULL as distinct anyway, but being
      // explicit says the constraint is about real values only.
      `CREATE UNIQUE INDEX idx_payments_client_ulid
         ON payments (client_ulid) WHERE client_ulid IS NOT NULL`,
      `ALTER TABLE payments ADD COLUMN tendered_sen INTEGER`,
      `ALTER TABLE payments ADD COLUMN change_sen INTEGER`,
      `ALTER TABLE payments ADD COLUMN rounding_sen INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE payments ADD COLUMN device_id TEXT`,
      `ALTER TABLE payments ADD COLUMN voided_at INTEGER`,
      `ALTER TABLE payments ADD COLUMN void_reason TEXT`,
      `ALTER TABLE payments ADD COLUMN receipt_no INTEGER`,
      // The day's takings range-scan this, the same reason v6 indexed
      // orders.placed_at.
      `CREATE INDEX idx_payments_paid_at ON payments (paid_at)`,

      // A discount is not a negative payment. Folding it into the cash column
      // would make the drawer balance while the books quietly lied about what
      // was sold, so it lives on its own with a compulsory reason and a name
      // against it.
      `CREATE TABLE bill_discounts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        amount_sen INTEGER NOT NULL,
        reason TEXT NOT NULL,
        given_by_user_id TEXT,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_bill_discounts_session ON bill_discounts (session_id)`,

      // Allocated inside the Durable Object, which is single-threaded, so two
      // receipts can never take the same number however busy the counter is.
      `ALTER TABLE settings ADD COLUMN receipt_seq INTEGER NOT NULL DEFAULT 0`,
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
