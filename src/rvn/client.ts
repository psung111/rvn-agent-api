import type { AssetInfo, ChainInfo, RvnNode } from './types.js';

export interface RpcConfig {
  url: string;
  user: string;
  pass: string;
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
}
