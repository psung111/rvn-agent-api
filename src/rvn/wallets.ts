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
 * Per-agent ravend wallets (v0.43.0): one ravend wallet per agentId, so
 * funding checks and execution run inside the agent's own wallet on a
 * real node instead of the one shared wallet. The wallet name is
 * derived from the agentId — the name IS the mapping, so no store seam
 * is needed (the per-agent *address* still lives in the wallets store,
 * minted inside the agent's wallet).
 *
 *   - `getOrCreateAgentWallet` is the submit path: it provisions the
 *     wallet when the agent has none (list -> load -> create), so a
 *     first submit creates the agent's wallet.
 *   - `getAgentWallet` is the read-only path (simulate): it never
 *     provisions — a simulation must not create persistent state — so
 *     callers fall back to the base node when the agent has no wallet
 *     yet.
 *
 * A wallet-layer failure throws: the server degrades to the base node
 * (the old shared-wallet behavior) instead of failing a decision the
 * policy engine already made.
 */
export const AGENT_WALLET_NAME_PREFIX = 'rvn-agent-api-';

/** The ravend wallet name for one agent: `rvn-agent-api-<agentId>`. */
export function agentWalletName(agentId: string): string {
  if (!isValidAgentId(agentId)) throw new Error('agentId must be a non-empty string');
  // ravend wallet names are file names on the node: keep only the safe
  // charset, collapsing the rest to '-'. Two agent ids that sanitize
  // to the same name would share a wallet — agent ids in practice are
  // already slug-like, so this is a documented edge, not a silent
  // merge of distinct production agents.
  const safe = agentId.trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  if (safe === '' || safe === '.' || safe === '..') {
    throw new Error('agentId has no usable wallet name');
  }
  return `${AGENT_WALLET_NAME_PREFIX}${safe}`;
}

/**
 * The agent's ravend wallet as a scoped node, provisioning it on first
 * call. Lists the loaded wallets first: when the wallet is already
 * loaded it is returned as-is; when it exists but is not loaded (a node
 * restart with load-on-startup off) it is loaded; otherwise it is
 * created (which also loads it). A create that loses a race ("already
 * exists") re-checks the list instead of failing. Throws when the
 * agent id is invalid or the node cannot provision the wallet — a
 * half-provisioned wallet is never returned, so the next call retries
 * cleanly.
 */
export async function getOrCreateAgentWallet(node: RvnNode, agentId: string): Promise<RvnNode> {
  const name = agentWalletName(agentId);
  if (typeof node.listWallets !== 'function' || typeof node.withWallet !== 'function') {
    throw new Error('node does not support per-agent wallets');
  }
  const loaded = await node.listWallets();
  if (loaded.includes(name)) return node.withWallet(name);
  try {
    await node.loadWallet(name);
  } catch {
    // No wallet file to load — create it. A concurrent provision that
    // wins the race makes createWallet throw "already exists"; the
    // wallet is loaded either way, so re-check the list before failing.
    try {
      await node.createWallet(name);
    } catch (err) {
      if (!(await node.listWallets()).includes(name)) throw err;
    }
  }
  return node.withWallet(name);
}

/**
 * Read-only: the agent's wallet as a scoped node when one is already
 * loaded, else the base node. Never provisions — use this on read paths
 * (simulate) that must not create persistent state.
 */
export async function getAgentWallet(node: RvnNode, agentId: string): Promise<RvnNode> {
  const name = agentWalletName(agentId);
  if (typeof node.listWallets !== 'function' || typeof node.withWallet !== 'function') {
    return node;
  }
  try {
    const loaded = await node.listWallets();
    return loaded.includes(name) ? node.withWallet(name) : node;
  } catch {
    return node;
  }
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
