/**
 * Per-agent wallet addresses (v0.41.0): one stable wallet address per
 * agentId, minted from the node on first use and tracked in the store,
 * so funding checks and fee debiting can be per-agent instead of
 * against one shared wallet balance.
 *
 *   - `getOrCreateWalletAddress` is the submit path: it provisions the
 *     address when the agent has none (a node call + a store write),
 *     so a first submit mints the agent's wallet.
 *   - `getWalletAddress` is the read-only path (simulate): it never
 *     provisions — a simulation must not create persistent state — so
 *     callers fall back to the wallet-wide balance when it returns
 *     undefined.
 *
 * The address is a node address labelled `rvn-agent-api:<agentId>`, so
 * an operator can find it in the wallet. The mapping is the authority:
 * once stored, the address never changes for that agent, even across
 * restarts (memory store aside) — a policy change or a new node cannot
 * silently re-point an agent's funds. Two concurrent first provisions
 * for the same agent can mint two addresses; the last store write wins
 * and the other address is simply never used (it holds nothing).
 */
import type { Store } from '../store/types.js';
import type { RvnNode } from './types.js';

/** Label prefix for per-agent wallet addresses minted from the node. */
export const AGENT_WALLET_LABEL_PREFIX = 'rvn-agent-api:';

/** The wallet label for one agent: `rvn-agent-api:<agentId>`. */
export function agentWalletLabel(agentId: string): string {
  return `${AGENT_WALLET_LABEL_PREFIX}${agentId}`;
}

function isValidAgentId(agentId: unknown): agentId is string {
  return typeof agentId === 'string' && agentId.trim().length > 0;
}

/**
 * Read-only: the agent's wallet address when one is already tracked,
 * else undefined. Never provisions — use this on read paths (simulate)
 * that must not create persistent state.
 */
export async function getWalletAddress(store: Store, agentId: string): Promise<string | undefined> {
  if (!isValidAgentId(agentId)) throw new Error('agentId must be a non-empty string');
  return store.wallets.get(agentId);
}

/**
 * The agent's wallet address, provisioning one from the node on first
 * call. Throws when the agent id is invalid, the node cannot mint an
 * address, or the store cannot record it — a half-provisioned address
 * (minted but not stored) is never returned, so the next call retries
 * cleanly instead of handing out an address the API cannot find again.
 */
export async function getOrCreateWalletAddress(
  store: Store,
  node: RvnNode,
  agentId: string,
): Promise<string> {
  if (!isValidAgentId(agentId)) throw new Error('agentId must be a non-empty string');
  const existing = await store.wallets.get(agentId);
  if (existing) return existing;
  const address = await node.getNewAddress(agentWalletLabel(agentId));
  if (typeof address !== 'string' || !address) {
    throw new Error('node returned no address for the agent wallet');
  }
  await store.wallets.set(agentId, address);
  return address;
}
