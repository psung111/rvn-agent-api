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
