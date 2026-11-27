import { randomUUID } from 'node:crypto';
import {
  estimateMinerFeeBaseUnits,
  ISSUANCE_FEE_BASE_UNITS,
  RVN_BASE_UNITS_PER_COIN,
} from '../policy/funding.js';
import type { AssetInfo, ChainInfo, RvnNode, WalletAssetBalance, WalletBalances } from './types.js';
import { AGENT_WALLET_LABEL_PREFIX } from './wallets.js';

/**
 * Default mock wallet RVN balance: 1,000,000 RVN — enough that the
 * demo loop and the test suites never trip the issuance-fee check by
 * accident. Override with MOCK_RVN_BALANCE_BASE_UNITS (base units, a
 * decimal string); a malformed value falls back to the default, never
 * a startup crash. The funding test sets it low on purpose to prove
 * the fee DENY path.
 */
export const DEFAULT_MOCK_RVN_BALANCE_BASE_UNITS = 1_000_000n * RVN_BASE_UNITS_PER_COIN;

function mockRvnBalanceFromEnv(): bigint {
  const raw = process.env.MOCK_RVN_BALANCE_BASE_UNITS;
  if (raw === undefined || raw === '') return DEFAULT_MOCK_RVN_BALANCE_BASE_UNITS;
  try {
    const parsed = BigInt(raw.trim());
    return parsed >= 0n ? parsed : DEFAULT_MOCK_RVN_BALANCE_BASE_UNITS;
  } catch {
    return DEFAULT_MOCK_RVN_BALANCE_BASE_UNITS;
  }
}

/**
 * Default mock fee rate: 10,000 sat/kB (0.0001 RVN/kB — Ravencoin's
 * default minimum relay fee). Override with
 * MOCK_FEE_RATE_BASE_UNITS_PER_KB (base units per kB); the literal
 * 'null' makes the mock unable to estimate, so the funding check
 * degrades to fee-only. A malformed value falls back to the default,
 * never a startup crash. The miner-fee test sets it low/high on purpose
 * to prove the boundary.
 */
export const DEFAULT_MOCK_FEE_RATE_BASE_UNITS_PER_KB = 10_000n;

function mockFeeRateFromEnv(): bigint | null {
  const raw = process.env.MOCK_FEE_RATE_BASE_UNITS_PER_KB;
  if (raw === undefined || raw === '') return DEFAULT_MOCK_FEE_RATE_BASE_UNITS_PER_KB;
  if (raw.trim() === 'null') return null;
  try {
    const parsed = BigInt(raw.trim());
    return parsed >= 0n ? parsed : DEFAULT_MOCK_FEE_RATE_BASE_UNITS_PER_KB;
  } catch {
    return DEFAULT_MOCK_FEE_RATE_BASE_UNITS_PER_KB;
  }
}

/**
 * Chain the mock reports from `getInfo()` (v0.40.0): 'mock' by default,
 * overridable with MOCK_CHAIN — set it to 'main' to exercise the
 * mainnet guardrail against the mock, or to 'test' / 'regtest' to
 * rehearse a live-node boot. An empty or whitespace-only value falls
 * back to 'mock', never a startup crash.
 */
function mockChainFromEnv(): string {
  const raw = process.env.MOCK_CHAIN;
  if (raw === undefined) return 'mock';
  const chain = raw.trim();
  return chain === '' ? 'mock' : chain;
}

/**
 * State of one mock wallet: its own RVN balances (per address) and its
 * own asset holdings (per asset, per address). Two wallets never share
 * a balance — an agent's wallet cannot spend another's RVN or assets,
 * which is the property the per-agent-wallet isolation tests prove.
 */
interface MockWalletState {
  /** Per-address RVN balances; the operator address is seeded at creation. */
  rvnBalances: Map<string, bigint>;
  /** Per-asset holdings: asset name -> address -> qty in base units. */
  assetBalances: Map<string, Map<string, bigint>>;
  /** Addresses this wallet knows (minted here or seen as a destination). */
  addresses: Set<string>;
  /** The wallet's operator address (seeded with MOCK_RVN_BALANCE...). */
  operatorAddress: string;
}

/**
 * Node-level state shared by every wallet view: the chain-global asset
 * registry (asset metadata lives on-chain, not in a wallet — ravend's
 * `listassets` / `getassetdata` are global RPCs), the block height, the
 * fee rate, the chain name, and the address counter (addresses are
 * globally unique, like on a real node).
 */
interface MockRegistry {
  wallets: Map<string, MockWalletState>;
  assets: Map<string, AssetInfo>;
  blocks: number;
  feeRate: bigint | null;
  chain: string;
  nextAddr: number;
}

/** Key of the default wallet in the registry — ravend's default wallet is `""`. */
export const DEFAULT_WALLET_NAME = '';

function newRegistry(): MockRegistry {
  const registry: MockRegistry = {
    wallets: new Map(),
    assets: new Map(),
    blocks: 3_100_000,
    feeRate: mockFeeRateFromEnv(),
    chain: mockChainFromEnv(),
    nextAddr: 1,
  };
  registry.wallets.set(DEFAULT_WALLET_NAME, newWalletState(registry));
  return registry;
}

function newWalletState(registry: MockRegistry): MockWalletState {
  const operatorAddress = `mtest1mock${String(registry.nextAddr++).padStart(6, '0')}xxxxxxxxxxxx`;
  const state: MockWalletState = {
    rvnBalances: new Map([[operatorAddress, mockRvnBalanceFromEnv()]]),
    assetBalances: new Map(),
    addresses: new Set([operatorAddress]),
    operatorAddress,
  };
  return state;
}

/**
 * In-memory Ravencoin node for development and demos. Implements the same
 * RvnNode interface as the real RPC client, so the API can't tell them apart.
 * No chain, no network, no funds — pure state machine.
 *
 * Wallet semantics (v0.36.0, per-agent since v0.41.0, per-address
 * assets since v0.42.0, per-agent ravend wallets since v0.43.0): the
 * asset registry is chain-global — an asset issued in one wallet is
 * visible to `listAssets` / `getAssetData` from every wallet, exactly
 * as on a real node, and the same name cannot be issued twice anywhere
 * — while RVN and asset *holdings* are per-wallet. Each wallet has its
 * own operator address seeded with MOCK_RVN_BALANCE_BASE_UNITS at
 * creation (the default wallet is seeded at construction), and each
 * per-agent wallet address minted with the `rvn-agent-api:` label is
 * seeded the same way on mint, like a faucet, so an agent's funding
 * check and fee debiting see its own balance and one agent cannot
 * spend another's RVN. Throwaway addresses (POST /v1/wallets) are not
 * seeded — they hold nothing. An issue credits the destination address
 * inside the issuing wallet; a transfer with a fromAddress debits only
 * that address (an agent can only transfer assets its own wallet
 * address holds), and the funding check reads the same address — so
 * check and execution agree per agent. A transfer without a
 * fromAddress (a direct node call) still debits from wherever the
 * balance lives inside that wallet, as before. The wallet-wide RVN
 * read is the sum of the wallet's seeded addresses, and the
 * wallet-wide asset read is the sum over every address in the wallet.
 */
export class MockRvnNode implements RvnNode {
  readonly walletName?: string;
  private registry: MockRegistry;

  constructor(registry?: MockRegistry, walletName = DEFAULT_WALLET_NAME) {
    this.registry = registry ?? newRegistry();
    this.walletName = walletName === DEFAULT_WALLET_NAME ? undefined : walletName;
  }

  /**
   * This view's wallet state — throws when the wallet was never created,
   * the way a real node refuses RPCs to a wallet that is not loaded.
   * `createWallet` / `loadWallet` / `listWallets` work on the registry
   * directly and never go through here.
   */
  private get state(): MockWalletState {
    const state = this.registry.wallets.get(this.walletName ?? DEFAULT_WALLET_NAME);
    if (!state) {
      throw new Error(`wallet ${this.walletName ?? DEFAULT_WALLET_NAME} is not loaded`);
    }
    return state;
  }

  /** RVN balance of one address in this wallet ('0' when unknown here). */
  private rvnBalanceOf(address: string): bigint {
    return this.state.rvnBalances.get(address) ?? 0n;
  }

  /** Wallet-wide RVN: the sum of every address this wallet has seeded. */
  private totalRvnBalance(): bigint {
    let total = 0n;
    for (const bal of this.state.rvnBalances.values()) total += bal;
    return total;
  }

  /** Estimated miner fee for an op at this mock's fee rate; 0 when the rate is unestimable — the check degrades to fee-only, so execution must too. */
  private minerFeeFor(kind: 'issue_asset' | 'reissue_asset' | 'issue_subasset' | 'issue_unique' | 'transfer_asset'): bigint {
    if (this.registry.feeRate === null) return 0n;
    return BigInt(estimateMinerFeeBaseUnits(kind, this.registry.feeRate.toString()));
  }

  /**
   * Debit the issuance fee plus the estimated miner fee from one
   * address's RVN balance, or throw exactly as ravend would when the
   * wallet cannot pay it. The funding check estimates the same total
   * against the same address, so a simulation that says "funded"
   * executes and one that says "insufficient RVN" fails the same way
   * for real — including a wallet holding exactly the issuance fee.
   * Without a fromAddress the wallet's operator address pays (the old
   * shared pool), so direct node calls keep their previous behavior.
   */
  private payIssuanceFee(
    kind: keyof typeof ISSUANCE_FEE_BASE_UNITS,
    op: string,
    fromAddress?: string,
  ): void {
    const fee = ISSUANCE_FEE_BASE_UNITS[kind] + this.minerFeeFor(kind);
    const address = fromAddress ?? this.state.operatorAddress;
    const balance = this.rvnBalanceOf(address);
    if (balance < fee) {
      throw new Error(
        `insufficient RVN balance for ${op} fee (needs ${fee}, wallet holds ${balance})`,
      );
    }
    this.state.rvnBalances.set(address, balance - fee);
  }

  private addr(prefix = 'mtest'): string {
    // Not real addresses — clearly fake, which is the point in mock mode.
    const a = `${prefix}1mock${String(this.registry.nextAddr++).padStart(6, '0')}xxxxxxxxxxxx`;
    this.state.addresses.add(a);
    return a;
  }

  /**
   * Create a wallet (v0.43.0): a fresh isolated ledger — its own
   * operator address seeded like the default wallet's — and load it, so
   * `withWallet(name)` can use it immediately. Throws when a wallet of
   * that name already exists, like ravend's `createwallet`, and when
   * the name is empty or looks like a path (ravend wallet names are
   * file names on the node).
   */
  async createWallet(name: string): Promise<void> {
    if (typeof name !== 'string' || name.trim() === '' || /[/\\]/.test(name)) {
      throw new Error(`invalid wallet name ${JSON.stringify(name)}`);
    }
    if (this.registry.wallets.has(name)) {
      throw new Error(`wallet ${name} already exists`);
    }
    this.registry.wallets.set(name, newWalletState(this.registry));
  }

  /**
   * Load a wallet that exists but is not loaded (v0.43.0). The mock has
   * no unload, so every created wallet is always loaded — this succeeds
   * for a created wallet and throws for one that was never created, the
   * way a real node refuses to load a missing wallet file.
   */
  async loadWallet(name: string): Promise<void> {
    if (!this.registry.wallets.has(name)) {
      throw new Error(`wallet ${name} not found`);
    }
  }

  /** Names of the loaded wallets, including the default wallet (`''`). */
  async listWallets(): Promise<string[]> {
    return [...this.registry.wallets.keys()];
  }

  /**
   * A view of this node scoped to one wallet (v0.43.0): the view shares
   * the registry (chain, blocks, fee rate, the global asset registry)
   * but reads and writes only that wallet's balances. Views of a wallet
   * that was never created throw on use, like a real node's
   * `/wallet/<name>` endpoint for an unloaded wallet.
   */
  withWallet(name: string): RvnNode {
    return new MockRvnNode(this.registry, name);
  }

  async getInfo(): Promise<ChainInfo> {
    return { chain: this.registry.chain, blocks: this.registry.blocks, connections: 0 };
  }

  async getNewAddress(label = ''): Promise<string> {
    const address = this.addr();
    // Per-agent wallet addresses (v0.41.0) are funded on mint, like a
    // faucet: the mock seeds each agent wallet with
    // MOCK_RVN_BALANCE_BASE_UNITS so the demo and the tests never trip
    // the fee check by accident. Throwaway addresses (POST /v1/wallets)
    // carry any other label and are not seeded — they hold nothing.
    if (label.startsWith(AGENT_WALLET_LABEL_PREFIX)) {
      this.state.rvnBalances.set(address, mockRvnBalanceFromEnv());
    }
    return address;
  }

  /** Holdings of one asset at one address in this wallet (0 when none). */
  private assetBalanceOf(assetName: string, address: string): bigint {
    return this.state.assetBalances.get(assetName.toUpperCase())?.get(address) ?? 0n;
  }

  /** Credit qty of an asset to an address in this wallet. */
  private creditAsset(assetName: string, address: string, qty: bigint): void {
    const name = assetName.toUpperCase();
    let perAsset = this.state.assetBalances.get(name);
    if (!perAsset) {
      perAsset = new Map();
      this.state.assetBalances.set(name, perAsset);
    }
    perAsset.set(address, (perAsset.get(address) ?? 0n) + qty);
  }

  async issueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
    fromAddress?: string;
  }): Promise<string> {
    const name = opts.name.toUpperCase();
    if (this.registry.assets.has(name)) throw new Error(`asset ${name} already exists`);
    if (!/^[A-Z0-9._]{3,30}$/.test(name)) throw new Error(`invalid asset name ${name}`);
    const qty = BigInt(opts.qty);
    if (qty <= 0n) throw new Error('qty must be positive');
    // The issuance fee is paid only when the issue actually happens —
    // a validation failure above throws before any fee is charged,
    // exactly as a failed ravend RPC broadcasts no transaction.
    this.payIssuanceFee('issue_asset', 'issue', opts.fromAddress);
    this.state.addresses.add(opts.toAddress);
    this.registry.assets.set(name, {
      name,
      amount: opts.qty,
      units: opts.units ?? 0,
      reissuable: opts.reissuable ?? true,
      ipfsHash: opts.ipfsHash,
    });
    this.creditAsset(name, opts.toAddress, qty);
    this.registry.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async transferAsset(assetName: string, qty: string, toAddress: string, fromAddress?: string): Promise<string> {
    const name = assetName.toUpperCase();
    const asset = this.registry.assets.get(name);
    if (!asset) throw new Error(`unknown asset ${name}`);
    const amount = BigInt(qty);
    if (amount <= 0n) throw new Error('qty must be positive');
    // The miner fee is paid in RVN: check the wallet can cover it
    // before moving any asset, so a failed transfer charges nothing —
    // the funding check requires the same RVN, so check and execution
    // agree here too. The fee comes from the issuing agent's wallet
    // address when one is given (v0.41.0), else the wallet's operator
    // address.
    const minerFee = this.minerFeeFor('transfer_asset');
    const feeAddress = fromAddress ?? this.state.operatorAddress;
    const feeBalance = this.rvnBalanceOf(feeAddress);
    if (feeBalance < minerFee) {
      throw new Error(
        `insufficient RVN balance for transfer miner fee (needs ${minerFee}, wallet holds ${feeBalance})`,
      );
    }
    // Per-address asset balances (v0.42.0): with a fromAddress the
    // transfer debits only that address — an agent can only transfer
    // assets its own wallet address holds, so one agent cannot spend
    // another's assets, and the funding check (which reads the same
    // address) agrees with execution. Without a fromAddress this is a
    // direct node call, so the old behavior stands: debit from wherever
    // the balance lives inside this wallet, as before.
    if (fromAddress !== undefined) {
      const held = this.assetBalanceOf(name, fromAddress);
      if (held < amount) {
        throw new Error(`insufficient ${name} balance at ${fromAddress}`);
      }
      this.state.assetBalances.get(name)!.set(fromAddress, held - amount);
    } else {
      const perAsset = this.state.assetBalances.get(name);
      let remaining = amount;
      if (perAsset) {
        for (const [addr, bal] of perAsset) {
          if (remaining <= 0n) break;
          const take = bal < remaining ? bal : remaining;
          perAsset.set(addr, bal - take);
          remaining -= take;
        }
      }
      if (remaining > 0n) throw new Error(`insufficient ${name} balance`);
    }
    this.state.addresses.add(toAddress);
    this.creditAsset(name, toAddress, amount);
    this.state.rvnBalances.set(feeAddress, feeBalance - minerFee);
    this.registry.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async reissueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    reissuable?: boolean;
    newUnits?: number;
    newIpfsHash?: string;
    fromAddress?: string;
  }): Promise<string> {
    const name = opts.name.toUpperCase();
    const asset = this.registry.assets.get(name);
    if (!asset) throw new Error(`unknown asset ${name}`);
    if (!asset.reissuable) throw new Error(`asset ${name} is not reissuable`);
    const qty = BigInt(opts.qty);
    if (qty <= 0n) throw new Error('qty must be positive');
    if (opts.newUnits !== undefined) {
      if (!Number.isInteger(opts.newUnits) || opts.newUnits < 0 || opts.newUnits > 8) {
        throw new Error('newUnits must be an integer in 0..8');
      }
      asset.units = opts.newUnits;
    }
    if (opts.newIpfsHash !== undefined) asset.ipfsHash = opts.newIpfsHash;
    if (opts.reissuable !== undefined) asset.reissuable = opts.reissuable;
    this.payIssuanceFee('reissue_asset', 'reissue', opts.fromAddress);
    this.state.addresses.add(opts.toAddress);
    this.creditAsset(name, opts.toAddress, qty);
    asset.amount = String(BigInt(asset.amount) + qty);
    this.registry.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async issueSubAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
    fromAddress?: string;
  }): Promise<string> {
    const name = opts.name.toUpperCase();
    const segments = name.split('/');
    // Node-level shape rule: every segment 1..30 chars of the asset alphabet.
    // (Policy per-segment matching happens in the policy engine, not here.)
    if (segments.length < 2 || segments.some((s) => !/^[A-Z0-9._]{1,30}$/.test(s))) {
      throw new Error(`invalid sub-asset name ${name}`);
    }
    if (this.registry.assets.has(name)) throw new Error(`asset ${name} already exists`);
    const parent = segments.slice(0, -1).join('/');
    if (!this.registry.assets.has(parent)) throw new Error(`unknown parent asset ${parent}`);
    const qty = BigInt(opts.qty);
    if (qty <= 0n) throw new Error('qty must be positive');
    this.payIssuanceFee('issue_subasset', 'sub-asset issue', opts.fromAddress);
    this.state.addresses.add(opts.toAddress);
    this.registry.assets.set(name, {
      name,
      amount: opts.qty,
      units: opts.units ?? 0,
      reissuable: opts.reissuable ?? true,
      ipfsHash: opts.ipfsHash,
    });
    this.creditAsset(name, opts.toAddress, qty);
    this.registry.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async issueUniqueAsset(opts: {
    name: string;
    toAddress: string;
    ipfsHash?: string;
    fromAddress?: string;
  }): Promise<string> {
    // The API uppercases asset names before they reach the node (as with
    // every other kind), so tags are case-insensitive here even though
    // ravend itself allows lowercase tags.
    const name = opts.name.toUpperCase();
    const parts = name.split('#');
    if (parts.length !== 2) throw new Error(`invalid unique asset name ${opts.name}`);
    const [root, tag] = parts;
    if (!root || !/^[A-Za-z0-9._-]{1,30}$/.test(tag)) {
      throw new Error(`invalid unique asset tag in ${opts.name}`);
    }
    if (this.registry.assets.has(name)) throw new Error(`asset ${name} already exists`);
    if (!this.registry.assets.has(root)) throw new Error(`unknown root asset ${root}`);
    // A unique asset is a singleton: amount 1, units 0, never reissuable.
    this.payIssuanceFee('issue_unique', 'unique-asset issue', opts.fromAddress);
    this.state.addresses.add(opts.toAddress);
    this.registry.assets.set(name, {
      name,
      amount: '1',
      units: 0,
      reissuable: false,
      ipfsHash: opts.ipfsHash,
    });
    this.creditAsset(name, opts.toAddress, 1n);
    this.registry.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async listAssets(pattern = '*'): Promise<AssetInfo[]> {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return [...this.registry.assets.values()]
      .filter((a) => re.test(a.name))
      .map((a) => ({ ...a }));
  }

  async getAssetData(name: string): Promise<AssetInfo | null> {
    const a = this.registry.assets.get(name.toUpperCase());
    return a ? { ...a } : null;
  }

  async getAssetBalance(assetName: string, address?: string): Promise<string | null> {
    const asset = this.registry.assets.get(assetName.toUpperCase());
    if (!asset) return null;
    // Per-address asset balances (v0.42.0): with an address, only what
    // that address holds in this wallet — null when it holds none of
    // the asset, so the funding check refuses an agent whose wallet
    // address holds nothing even when another wallet holds plenty.
    // Without an address the balance this wallet holds, as before — and
    // it is exactly what a transfer without a fromAddress can debit in
    // this wallet, so the check and the execution agree there too.
    if (address !== undefined) {
      const held = this.assetBalanceOf(assetName, address);
      return held > 0n ? held.toString() : null;
    }
    let total = 0n;
    for (const bal of this.state.assetBalances.get(assetName.toUpperCase())?.values() ?? []) {
      total += bal;
    }
    return total > 0n ? total.toString() : null;
  }

  async getRvnBalance(address?: string): Promise<string> {
    // No address: this wallet's total (the sum of every address it has
    // seeded). With an address: that address's balance in this wallet,
    // '0' when the mock knows nothing about it — an unprovisioned
    // address holds nothing, and the funding check agrees with
    // execution here too.
    if (address === undefined) return this.totalRvnBalance().toString();
    return this.rvnBalanceOf(address).toString();
  }

  async estimateFeeRateBaseUnitsPerKb(): Promise<string | null> {
    return this.registry.feeRate === null ? null : this.registry.feeRate.toString();
  }

  async listWalletBalances(address?: string): Promise<WalletBalances> {
    // Per-address asset balances (v0.42.0): with an address, only the
    // assets that address holds in this wallet (nonzero) — an asset
    // fully transferred out of that address disappears from its list,
    // matching ravend's `listassetbalancesbyaddress`. Without an address
    // this wallet's list, as before. The RVN figure is the agent's own
    // balance when an address is given (v0.41.0).
    const assets: WalletAssetBalance[] = [];
    for (const asset of this.registry.assets.values()) {
      let balance: bigint;
      if (address !== undefined) {
        balance = this.assetBalanceOf(asset.name, address);
      } else {
        balance = 0n;
        for (const bal of this.state.assetBalances.get(asset.name)?.values() ?? []) {
          balance += bal;
        }
      }
      if (balance > 0n) {
        assets.push({ name: asset.name, balanceBaseUnits: balance.toString(), units: asset.units });
      }
    }
    assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { rvnBaseUnits: await this.getRvnBalance(address), assets };
  }
}
