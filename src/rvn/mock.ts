import { randomUUID } from 'node:crypto';
import type { AssetInfo, ChainInfo, RvnNode } from './types.js';

/**
 * In-memory Ravencoin node for development and demos. Implements the same
 * RvnNode interface as the real RPC client, so the API can't tell them apart.
 * No chain, no network, no funds — pure state machine.
 */
export class MockRvnNode implements RvnNode {
  private assets = new Map<string, AssetInfo & { balances: Map<string, bigint> }>();
  private addresses = new Set<string>();
  private blocks = 3_100_000;
  private nextAddr = 1;

  private addr(prefix = 'mtest'): string {
    // Not real addresses — clearly fake, which is the point in mock mode.
    const a = `${prefix}1mock${String(this.nextAddr++).padStart(6, '0')}xxxxxxxxxxxx`;
    this.addresses.add(a);
    return a;
  }

  async getInfo(): Promise<ChainInfo> {
    return { chain: 'mock', blocks: this.blocks, connections: 0 };
  }

  async getNewAddress(): Promise<string> {
    return this.addr();
  }

  async issueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
  }): Promise<string> {
    const name = opts.name.toUpperCase();
    if (this.assets.has(name)) throw new Error(`asset ${name} already exists`);
    if (!/^[A-Z0-9._]{3,30}$/.test(name)) throw new Error(`invalid asset name ${name}`);
    const qty = BigInt(opts.qty);
    if (qty <= 0n) throw new Error('qty must be positive');
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

  async transferAsset(assetName: string, qty: string, toAddress: string): Promise<string> {
    const name = assetName.toUpperCase();
    const asset = this.assets.get(name);
    if (!asset) throw new Error(`unknown asset ${name}`);
    const amount = BigInt(qty);
    if (amount <= 0n) throw new Error('qty must be positive');
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
}
