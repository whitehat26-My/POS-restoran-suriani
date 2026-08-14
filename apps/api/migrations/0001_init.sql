-- Control plane. Who exists and what they own.
-- Restaurant trading data lives in each outlet's Durable Object, not here.

CREATE TABLE organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  ssm_no     TEXT,
  plan       TEXT NOT NULL DEFAULT 'pilot',
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  role       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  pin_salt   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_org ON users (org_id);
CREATE UNIQUE INDEX idx_users_phone ON users (phone);

CREATE TABLE outlets (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  name       TEXT NOT NULL,
  address    TEXT,
  -- Random, never derived from id. Guessing outlet ids must not lead to a
  -- Durable Object.
  do_id      TEXT NOT NULL UNIQUE,
  timezone   TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  status     TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_outlets_org ON outlets (org_id);

CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  outlet_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  last_seen_at   INTEGER,
  app_version    TEXT,
  printer_config TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_devices_outlet ON devices (outlet_id);

CREATE TABLE usage_daily (
  outlet_id   TEXT NOT NULL,
  date        TEXT NOT NULL,
  orders      INTEGER NOT NULL DEFAULT 0,
  revenue_sen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_usage_outlet_date ON usage_daily (outlet_id, date);
