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
 * In-memory Ravencoin node for development and demos. Implements the same
 * RvnNode interface as the real RPC client, so the API can't tell them apart.
 * No chain, no network, no funds — pure state machine.
 *
 * Wallet semantics (v0.36.0, per-agent since v0.41.0): RVN is tracked
 * per address. The mock seeds one operator address at construction with
 * MOCK_RVN_BALANCE_BASE_UNITS (default 1,000,000 RVN) — that is the old
 * single shared balance, so a fresh mock still reports it wallet-wide
 * and direct node calls without a fromAddress debit it. Each per-agent
 * wallet address minted with the `rvn-agent-api:` label is seeded with
 * the same default on mint, like a faucet, so an agent's funding check
 * and fee debiting see its own balance and one agent cannot spend
 * another's RVN. Throwaway addresses (POST /v1/wallets) are not
 * seeded — they hold nothing. Asset balances are still wallet-wide:
 * every balance the ledger records is treated as wallet-held (see
 * getAssetBalance), which is what makes the funding check agree with
 * execution for transfers; per-address asset balances are slice 2.
 * The wallet-wide RVN read is the sum of every seeded address.
 */
export class MockRvnNode implements RvnNode {
  private assets = new Map<string, AssetInfo & { balances: Map<string, bigint> }>();
  private addresses = new Set<string>();
  private blocks = 3_100_000;
  private nextAddr = 1;
  private feeRate = mockFeeRateFromEnv();
  private chain = mockChainFromEnv();
  /** Per-address RVN balances; the operator address is seeded at construction. */
  private rvnBalances = new Map<string, bigint>();
  private operatorAddress: string;

  constructor() {
    this.operatorAddress = this.addr();
    this.rvnBalances.set(this.operatorAddress, mockRvnBalanceFromEnv());
  }

  /** RVN balance of one address ('0' when the mock knows nothing about it). */
  private rvnBalanceOf(address: string): bigint {
    return this.rvnBalances.get(address) ?? 0n;
  }

  /** Wallet-wide RVN: the sum of every address the mock has seeded. */
  private totalRvnBalance(): bigint {
    let total = 0n;
    for (const bal of this.rvnBalances.values()) total += bal;
    return total;
  }

  /** Estimated miner fee for an op at this mock's fee rate; 0 when the rate is unestimable — the check degrades to fee-only, so execution must too. */
  private minerFeeFor(kind: 'issue_asset' | 'reissue_asset' | 'issue_subasset' | 'issue_unique' | 'transfer_asset'): bigint {
    if (this.feeRate === null) return 0n;
    return BigInt(estimateMinerFeeBaseUnits(kind, this.feeRate.toString()));
  }

  /**
   * Debit the issuance fee plus the estimated miner fee from one
   * address's RVN balance, or throw exactly as ravend would when the
   * wallet cannot pay it. The funding check estimates the same total
   * against the same address, so a simulation that says "funded"
   * executes and one that says "insufficient RVN" fails the same way
   * for real — including a wallet holding exactly the issuance fee.
   * Without a fromAddress the operator address pays (the old shared
   * pool), so direct node calls keep their previous behavior.
   */
  private payIssuanceFee(
    kind: keyof typeof ISSUANCE_FEE_BASE_UNITS,
    op: string,
    fromAddress?: string,
  ): void {
    const fee = ISSUANCE_FEE_BASE_UNITS[kind] + this.minerFeeFor(kind);
    const address = fromAddress ?? this.operatorAddress;
    const balance = this.rvnBalanceOf(address);
    if (balance < fee) {
      throw new Error(
        `insufficient RVN balance for ${op} fee (needs ${fee}, wallet holds ${balance})`,
      );
    }
    this.rvnBalances.set(address, balance - fee);
  }

  private addr(prefix = 'mtest'): string {
    // Not real addresses — clearly fake, which is the point in mock mode.
    const a = `${prefix}1mock${String(this.nextAddr++).padStart(6, '0')}xxxxxxxxxxxx`;
    this.addresses.add(a);
    return a;
  }

  async getInfo(): Promise<ChainInfo> {
    return { chain: this.chain, blocks: this.blocks, connections: 0 };
  }

  async getNewAddress(label = ''): Promise<string> {
    const address = this.addr();
    // Per-agent wallet addresses (v0.41.0) are funded on mint, like a
    // faucet: the mock seeds each agent wallet with
    // MOCK_RVN_BALANCE_BASE_UNITS so the demo and the tests never trip
    // the fee check by accident. Throwaway addresses (POST /v1/wallets)
    // carry any other label and are not seeded — they hold nothing.
    if (label.startsWith(AGENT_WALLET_LABEL_PREFIX)) {
      this.rvnBalances.set(address, mockRvnBalanceFromEnv());
    }
    return address;
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
    if (this.assets.has(name)) throw new Error(`asset ${name} already exists`);
    if (!/^[A-Z0-9._]{3,30}$/.test(name)) throw new Error(`invalid asset name ${name}`);
    const qty = BigInt(opts.qty);
    if (qty <= 0n) throw new Error('qty must be positive');
    // The issuance fee is paid only when the issue actually happens —
    // a validation failure above throws before any fee is charged,
    // exactly as a failed ravend RPC broadcasts no transaction.
    this.payIssuanceFee('issue_asset', 'issue', opts.fromAddress);
    this.addresses.add(opts.toAddress);
    this.assets.set(name, {
      name,
      amount: opts.qty,
      units: opts.units ?? 0,
      reissuable: opts.reissuable ?? true,
      ipfsHash: opts.ipfsHash,
      balances: new Map([[opts.toAddress, qty]]),
    });
    this.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async transferAsset(assetName: string, qty: string, toAddress: string, fromAddress?: string): Promise<string> {
    const name = assetName.toUpperCase();
    const asset = this.assets.get(name);
    if (!asset) throw new Error(`unknown asset ${name}`);
    const amount = BigInt(qty);
    if (amount <= 0n) throw new Error('qty must be positive');
    // The miner fee is paid in RVN: check the wallet can cover it
    // before moving any asset, so a failed transfer charges nothing —
    // the funding check requires the same RVN, so check and execution
    // agree here too. The fee comes from the issuing agent's wallet
    // address when one is given (v0.41.0), else the operator address.
    const minerFee = this.minerFeeFor('transfer_asset');
    const feeAddress = fromAddress ?? this.operatorAddress;
    const feeBalance = this.rvnBalanceOf(feeAddress);
    if (feeBalance < minerFee) {
      throw new Error(
        `insufficient RVN balance for transfer miner fee (needs ${minerFee}, wallet holds ${feeBalance})`,
      );
    }
    // Debit the issuer's first address holding enough (mock simplification:
    // debit from wherever the balance lives, preferring the first holder).
    let remaining = amount;
    for (const [addr, bal] of asset.balances) {
      if (remaining <= 0n) break;
      const take = bal < remaining ? bal : remaining;
      asset.balances.set(addr, bal - take);
      remaining -= take;
    }
    if (remaining > 0n) throw new Error(`insufficient ${name} balance`);
    this.addresses.add(toAddress);
    asset.balances.set(toAddress, (asset.balances.get(toAddress) ?? 0n) + amount);
    this.rvnBalances.set(feeAddress, feeBalance - minerFee);
    this.blocks += 1;
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
    const asset = this.assets.get(name);
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
    this.addresses.add(opts.toAddress);
    asset.balances.set(opts.toAddress, (asset.balances.get(opts.toAddress) ?? 0n) + qty);
    asset.amount = String(BigInt(asset.amount) + qty);
    this.blocks += 1;
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
    if (this.assets.has(name)) throw new Error(`asset ${name} already exists`);
    const parent = segments.slice(0, -1).join('/');
    if (!this.assets.has(parent)) throw new Error(`unknown parent asset ${parent}`);
    const qty = BigInt(opts.qty);
    if (qty <= 0n) throw new Error('qty must be positive');
    this.payIssuanceFee('issue_subasset', 'sub-asset issue', opts.fromAddress);
    this.addresses.add(opts.toAddress);
    this.assets.set(name, {
      name,
      amount: opts.qty,
      units: opts.units ?? 0,
      reissuable: opts.reissuable ?? true,
      ipfsHash: opts.ipfsHash,
      balances: new Map([[opts.toAddress, qty]]),
    });
    this.blocks += 1;
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
    if (this.assets.has(name)) throw new Error(`asset ${name} already exists`);
    if (!this.assets.has(root)) throw new Error(`unknown root asset ${root}`);
    // A unique asset is a singleton: amount 1, units 0, never reissuable.
    this.payIssuanceFee('issue_unique', 'unique-asset issue', opts.fromAddress);
    this.addresses.add(opts.toAddress);
    this.assets.set(name, {
      name,
      amount: '1',
      units: 0,
      reissuable: false,
      ipfsHash: opts.ipfsHash,
      balances: new Map([[opts.toAddress, 1n]]),
    });
    this.blocks += 1;
    return `mock-txid-${randomUUID()}`;
  }

  async listAssets(pattern = '*'): Promise<AssetInfo[]> {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return [...this.assets.values()]
      .filter((a) => re.test(a.name))
      .map(({ balances: _b, ...info }) => info);
  }

  async getAssetData(name: string): Promise<AssetInfo | null> {
    const a = this.assets.get(name.toUpperCase());
    if (!a) return null;
    const { balances: _b, ...info } = a;
    return info;
  }

  async getAssetBalance(assetName: string): Promise<string | null> {
    const asset = this.assets.get(assetName.toUpperCase());
    if (!asset) return null;
    // The mock has no separate wallet: every balance the ledger records
    // is wallet-held, so the total is the balance — and it is exactly
    // what transferAsset can debit, so the check and the execution agree.
    let total = 0n;
    for (const bal of asset.balances.values()) total += bal;
    return total.toString();
  }

  async getRvnBalance(address?: string): Promise<string> {
    // No address: the wallet-wide total (the sum of every seeded
    // address). With an address: that address's balance, '0' when the
    // mock knows nothing about it — an unprovisioned address holds
    // nothing, and the funding check agrees with execution here too.
    if (address === undefined) return this.totalRvnBalance().toString();
    return this.rvnBalanceOf(address).toString();
  }

  async estimateFeeRateBaseUnitsPerKb(): Promise<string | null> {
    return this.feeRate === null ? null : this.feeRate.toString();
  }

  async listWalletBalances(address?: string): Promise<WalletBalances> {
    // Same wallet semantics as getAssetBalance: every balance the
    // ledger records is wallet-held. Assets fully transferred out
    // (total 0) are not listed, matching ravend's `listmyassets`. The
    // RVN figure is the agent's own balance when an address is given
    // (v0.41.0); the asset list stays wallet-wide until per-address
    // asset balances land (slice 2 of per-agent wallets).
    const assets: WalletAssetBalance[] = [];
    for (const asset of this.assets.values()) {
      let total = 0n;
      for (const bal of asset.balances.values()) total += bal;
      if (total > 0n) {
        assets.push({ name: asset.name, balanceBaseUnits: total.toString(), units: asset.units });
      }
    }
    assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { rvnBaseUnits: await this.getRvnBalance(address), assets };
  }
}
