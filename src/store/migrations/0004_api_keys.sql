-- 0004_api_keys: per-agent API keys for the v0.29.0 auth gate.
--
-- Only SHA-256 hashes are stored — the raw key is shown once at issue
-- time and never again. key_hash is unique, so the same key can never be
-- issued twice; revocation sets revoked_at_ms instead of deleting the
-- row, so a revoked key stays auditable. The verifier refuses revoked
-- records (see src/auth/keys.ts), so the store itself returns them
-- unchanged.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT
);

CREATE INDEX IF NOT EXISTS api_keys_agent_id ON api_keys (agent_id);
