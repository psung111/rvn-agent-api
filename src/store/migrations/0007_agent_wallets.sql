-- 0007_agent_wallets: per-agent wallet addresses (v0.41.0).
--
-- One row per agent: the stable wallet address minted from the node on
-- first use (label `rvn-agent-api:<agentId>`), so funding checks and fee
-- debiting can be per-agent instead of against one shared wallet
-- balance. The address never changes once stored — a restart or a
-- policy change cannot silently re-point an agent's funds.
CREATE TABLE IF NOT EXISTS agent_wallets (
  agent_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);
