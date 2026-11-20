import type { AssetInfo, ChainInfo, RvnNode } from './types.js';

export interface RpcConfig {
  url: string;
  user: string;
  pass: string;
}

/**
 * Convert a ravend decimal amount (RVN, or an asset amount in display
 * units) to base units without ever going through a float: the RPC
 * returns JSON numbers, so parse the decimal string digit by digit.
 * `decimals` is the asset's units (8 for RVN). Extra precision beyond
 * `decimals` places is truncated — ravend never returns more than the
 * asset's own precision.
 */
export function decimalToBaseUnits(value: number | string, decimals: number): string {
  let text = String(value).trim();
  // Expand scientific notation first: String(0.00000001) is '1e-8', and
  // a small getbalance can arrive the same way after JSON parsing.
  const expMatch = text.match(/^(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/);
  if (expMatch) {
    const [, mantissa, expStr] = expMatch;
    const exp = Number(expStr);
    const [whole, frac = ''] = mantissa.split('.');
    const digits = whole + frac;
    const point = whole.length + exp; // decimal-point position within digits
    if (point <= 0) text = '0.' + '0'.repeat(-point) + digits;
    else if (point >= digits.length) text = digits + '0'.repeat(point - digits.length);
    else text = digits.slice(0, point) + '.' + digits.slice(point);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a non-negative decimal: ${text}`);
  const [whole, frac = ''] = text.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}

/**
 * Thin JSON-RPC client for ravend.
 *
 * RPC shapes follow the Ravencoin asset RPCs (issue / transfer / listassets /
 * getassetdata). Parameter order matters in ravend — verify against your node's
 * `help <command>` if anything misbehaves across versions.
 */
export class RvnRpcClient implements RvnNode {
  constructor(private config: RpcConfig) {}

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const auth = Buffer.from(`${this.config.user}:${this.config.pass}`).toString('base64');
    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'rvn-agent-api', method, params }),
    });
    if (!res.ok) throw new Error(`rvn rpc http ${res.status} on ${method}`);
    const json = (await res.json()) as { result?: T; error?: { message?: string } | null };
    if (json.error) throw new Error(`rvn rpc ${method}: ${json.error.message ?? 'unknown error'}`);
    return json.result as T;
  }

  async getInfo(): Promise<ChainInfo> {
    const r = await this.call<{ chain: string; blocks: number; connections: number }>(
      'getblockchaininfo',
    );
    return { chain: r.chain, blocks: r.blocks, connections: r.connections };
  }

  async getNewAddress(label = ''): Promise<string> {
    return this.call<string>('getnewaddress', label ? [label] : []);
  }

  async issueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
  }): Promise<string> {
    const units = opts.units ?? 0;
    const reissuable = opts.reissuable ?? true;
    // issue "asset_name" qty "to_address" units reissuable [ipfs_hash]
    const params: unknown[] = [opts.name, Number(opts.qty), opts.toAddress, units, reissuable];
    if (opts.ipfsHash) params.push(opts.ipfsHash);
    return this.call<string>('issue', params);
  }

  async transferAsset(assetName: string, qty: string, toAddress: string): Promise<string> {
    // transfer "asset_name" qty "to_address"
    return this.call<string>('transfer', [assetName, Number(qty), toAddress]);
  }

  async reissueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    reissuable?: boolean;
    newUnits?: number;
    newIpfsHash?: string;
  }): Promise<string> {
    // reissue "asset_name" qty "to_address" change_address reissuable new_units new_ipfs_hash
    // (params are positional: new_ipfs_hash can only be set when new_units is too)
    const params: unknown[] = [opts.name, Number(opts.qty), opts.toAddress, '', opts.reissuable ?? true];
    if (opts.newUnits !== undefined) {
      params.push(opts.newUnits);
      if (opts.newIpfsHash !== undefined) params.push(opts.newIpfsHash);
    }
    return this.call<string>('reissue', params);
  }

  async issueSubAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
  }): Promise<string> {
    // ravend issues sub-assets through the same `issue` RPC — the slash
    // name is what makes it a sub-asset, and ravend itself enforces that
    // the parent exists and is owned by the issuer's wallet.
    return this.issueAsset(opts);
  }

  async issueUniqueAsset(opts: {
    name: string;
    toAddress: string;
    ipfsHash?: string;
  }): Promise<string> {
    // issueunique "root_name" ["tag", ...] "ipfs_hash" "to_address" "change_address"
    // — one tag per API call, so the tag list has a single entry. The tag
    // charset is wider than root names (lowercase allowed on-chain), but
    // the API uppercases names before they reach the node.
    const [root, tag] = opts.name.split('#');
    if (root === undefined || tag === undefined || opts.name.split('#').length !== 2) {
      throw new Error(`invalid unique asset name ${opts.name}`);
    }
    return this.call<string>('issueunique', [root, [tag], opts.ipfsHash ?? '', opts.toAddress, '']);
  }

  async listAssets(pattern = '*'): Promise<AssetInfo[]> {
    // listassets "( asset_name )" verbose — verbose=true returns per-asset objects
    const raw = await this.call<Record<string, { amount: number; units: number; reissuable: number; ipfs_hash?: string }>>(
      'listassets',
      [pattern, true],
    );
    return Object.entries(raw ?? {}).map(([name, a]) => ({
      name,
      amount: String(a.amount),
      units: a.units,
      reissuable: a.reissuable === 1,
      ipfsHash: a.ipfs_hash || undefined,
    }));
  }

  async getAssetData(name: string): Promise<AssetInfo | null> {
    try {
      const a = await this.call<{
        name: string;
        amount: number;
        units: number;
        reissuable: number;
        ipfs_hash?: string;
      }>('getassetdata', [name]);
      if (!a) return null;
      return {
        name: a.name,
        amount: String(a.amount),
        units: a.units,
        reissuable: a.reissuable === 1,
        ipfsHash: a.ipfs_hash || undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Wallet balance of one asset, in base units — null when the wallet
   * holds none of it. `listmyassets` lists only wallet-owned assets, so
   * an absent entry means "not held", not "unknown". The verbose form
   * returns per-asset objects with amount (display units) and units;
   * a plain-number shape falls back to `getassetdata` for the units.
   * NOTE: this path is implemented against the documented RPC shapes
   * and is not verified against a live ravend on this VM (no live node
   * here) — the mock leg is what the test suite exercises.
   */
  async getAssetBalance(assetName: string): Promise<string | null> {
    const name = assetName.toUpperCase();
    const raw = await this.call<Record<
      string,
      number | { amount: number; units: number }
    > | null>('listmyassets', [name, true]);
    if (!raw) return null;
    const entry = raw[name];
    if (entry === undefined) return null;
    if (typeof entry === 'number') {
      const data = await this.getAssetData(name);
      if (!data) return null;
      return decimalToBaseUnits(entry, data.units);
    }
    return decimalToBaseUnits(entry.amount, entry.units);
  }

  /** Wallet RVN balance in base units (1 RVN = 10^8), via `getbalance`. */
  async getRvnBalance(): Promise<string> {
    const balance = await this.call<number>('getbalance');
    return decimalToBaseUnits(balance, 8);
  }
}
