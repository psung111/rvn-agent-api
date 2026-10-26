-- rvn-agent-api persistence schema.
-- Applied idempotently at startup (CREATE TABLE IF NOT EXISTS); the API never
-- alters existing tables, so schema changes ship as new migration files.

CREATE TABLE IF NOT EXISTS policies (
  agent_id   TEXT PRIMARY KEY,
  policy     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intents (
  id         TEXT PRIMARY KEY,
  intent     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisions (
  intent_id  TEXT PRIMARY KEY,
  decision   JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The audit chain: seq is assigned inside a serialized transaction (see
-- PostgresAuditStore.append), so the hash chain can never fork.
-- detail is TEXT (not JSONB): JSONB reorders object keys on write, which
-- would change the bytes the audit hash was computed over. The stored JSON
-- is canonical (recursively key-sorted, see makeChainedEntry) and
-- round-trips byte-exact as text.
CREATE TABLE IF NOT EXISTS audit_entries (
  seq       BIGINT PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  at_ms     BIGINT NOT NULL,
  kind      TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  detail    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_entries_intent_id ON audit_entries (intent_id);

-- Rolling issue-spend ledger. Quantities are decimal strings in base units
-- (arbitrary precision, never floats); window sums are computed in SQL.
CREATE TABLE IF NOT EXISTS ledger_spend (
  agent_id        TEXT NOT NULL,
  at_ms           BIGINT NOT NULL,
  qty_base_units  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_spend_agent_at ON ledger_spend (agent_id, at_ms);
