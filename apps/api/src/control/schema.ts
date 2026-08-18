/**
 * D1 CONTROL PLANE
 *
 * Who exists and what they own: organisations, staff, outlets, devices,
 * billing. Deliberately NOT restaurant operating data — menus, tables, orders
 * and payments all live inside each outlet's own Durable Object, so no query
 * here can ever reach another tenant's trading data.
 *
 * All money is integer sen. Never a float.
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** SSM company registration number, once the business is registered. */
  ssmNo: text("ssm_no"),
  plan: text("plan").notNull().default("pilot"),
  createdAt: integer("created_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    /** owner | manager | cashier */
    role: text("role").notNull(),
    /** PBKDF2 over the staff PIN. Never the PIN itself. */
    pinHash: text("pin_hash").notNull(),
    pinSalt: text("pin_salt").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_users_org").on(t.orgId)],
);

export const outlets = sqliteTable(
  "outlets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    /**
     * The Durable Object name for this outlet's data.
     *
     * A RANDOM string, deliberately not derived from `id`. If an attacker
     * guesses or enumerates outlet ids they still cannot address the Durable
     * Object, because the mapping only exists in this row.
     */
    doId: text("do_id").notNull().unique(),
    timezone: text("timezone").notNull().default("Asia/Kuala_Lumpur"),
    /** active | suspended */
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_outlets_org").on(t.orgId)],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    outletId: text("outlet_id").notNull(),
    name: text("name").notNull(),
    lastSeenAt: integer("last_seen_at"),
    appVersion: text("app_version"),
    /** JSON: printer IPs, Bluetooth MACs, local server port. */
    printerConfig: text("printer_config"),
    /**
     * PBKDF2 hash of this device's token.
     *
     * A print agent runs unattended on a tablet in the back; it cannot borrow
     * a cashier's PIN session. The token is shown once at registration and
     * only its hash is kept, so a database leak does not hand anyone a
     * working agent credential.
     */
    tokenHash: text("token_hash"),
    tokenSalt: text("token_salt"),
    /** device | print_agent */
    kind: text("kind").notNull().default("device"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_devices_outlet").on(t.outletId)],
);

/**
 * Nightly rollup from each outlet's Durable Object, so cross-branch reporting
 * and usage metering can be answered without waking every outlet.
 */
export const usageDaily = sqliteTable(
  "usage_daily",
  {
    outletId: text("outlet_id").notNull(),
    /** YYYY-MM-DD in the outlet's own timezone. */
    date: text("date").notNull(),
    orders: integer("orders").notNull().default(0),
    revenueSen: integer("revenue_sen").notNull().default(0),
  },
  (t) => [index("idx_usage_outlet_date").on(t.outletId, t.date)],
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Outlet = typeof outlets.$inferSelect;
export type Device = typeof devices.$inferSelect;
