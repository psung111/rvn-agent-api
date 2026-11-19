-- 0006_policy_history: superseded policy versions for history + rollback (v0.35.0).
--
-- One row per replaced policy: the full policy document as JSONB, the
-- moment it was replaced, and how it was replaced ('put' / 'preset' /
-- 'rollback'). `preset` names the preset that produced this version;
-- `source_version_id` names the version a rollback restored from.
-- The live policy is never in this table — only versions it replaced —
-- and the server prunes each agent to the configured history limit
-- (RVN_POLICY_HISTORY_LIMIT, default 10) at record time, so the table
-- stays bounded without a migration of its own.
CREATE TABLE IF NOT EXISTS policy_history (
  version_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  policy JSONB NOT NULL,
  replaced_at_ms BIGINT NOT NULL,
  replaced_by TEXT NOT NULL CHECK (replaced_by IN ('put', 'preset', 'rollback')),
  preset TEXT,
  source_version_id TEXT
);

CREATE INDEX IF NOT EXISTS policy_history_agent_idx
  ON policy_history (agent_id, replaced_at_ms DESC);
