-- 0001_initial: baseline schema (previously src/store/schema.sql, applied
-- via CREATE TABLE IF NOT EXISTS at startup). Every statement keeps its
-- IF NOT EXISTS guard, so a database created by the old schema.sql applies
-- this migration as a no-op and just records it in schema_migrations.
--
-- rvn-agent-api persistence schema.

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

-- Rate-limit buckets (v0.20.0): one row per agent, holding the token
-- balance and the instant it was last computed, so a restart resumes the
-- bucket instead of refilling it. Tokens are fractional (continuous
-- refill); updated_ms is epoch milliseconds. Rows are upserted on every
-- gate evaluation and read back in full at boot.
CREATE TABLE IF NOT EXISTS ratelimit_buckets (
  key        TEXT PRIMARY KEY,
  tokens     DOUBLE PRECISION NOT NULL,
  updated_ms BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
