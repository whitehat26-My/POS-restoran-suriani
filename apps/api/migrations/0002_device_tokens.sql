-- A print agent runs unattended and needs its own credential, scoped to one
-- outlet. Only the hash is stored; the token itself is shown once.
ALTER TABLE devices ADD COLUMN token_hash TEXT;
ALTER TABLE devices ADD COLUMN token_salt TEXT;
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'device';
CREATE INDEX idx_devices_kind ON devices (kind);
