import type { AssetInfo, ChainInfo, RvnNode, WalletAssetBalance, WalletBalances } from './types.js';

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
  /**
   * `walletName` (v0.43.0) scopes this client to one ravend wallet:
   * wallet RPCs go to the `/wallet/<name>` endpoint, so the wallet's own
   * UTXOs and assets fund and receive the calls. Undefined is the
   * default wallet (the bare RPC URL). Node-level RPCs (chain info, fee
   * estimate) and the chain-global asset registry always use the base
   * URL, as do the wallet-management RPCs — ravend answers those only
   * without a wallet context.
   */
  constructor(
    private config: RpcConfig,
    readonly walletName?: string,
  ) {}

  private async call<T>(method: string, params: unknown[] = [], opts: { base?: boolean } = {}): Promise<T> {
    const auth = Buffer.from(`${this.config.user}:${this.config.pass}`).toString('base64');
    // A wallet-scoped call goes to /wallet/<name>; the wallet name is
    // percent-encoded, so names with spaces or other specials still
    // route (ravend decodes the path segment).
    const url =
      !opts.base && this.walletName !== undefined
        ? `${this.config.url}/wallet/${encodeURIComponent(this.walletName)}`
        : this.config.url;
    const res = await fetch(url, {
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

  /**
   * Create a ravend wallet and load it (`createwallet`), so the API can
   * provision one wallet per agent on a real node. Called on the base
   * URL — wallet management is not itself wallet-scoped. Throws when a
   * wallet of that name already exists (the provisioning helper treats
   * that as "already provisioned"). NOTE: implemented against the
   * documented RPC shape and not verified against a live ravend on this
   * VM (no live node here) — the mock leg and the stubbed-fetch units
   * in `pnpm test:agent-wallets` are what the suite exercises.
   */
  async createWallet(name: string): Promise<void> {
    await this.call<{ name: string; warning?: string }>('createwallet', [name], { base: true });
  }

  /** Load a wallet file that exists but is not loaded (`loadwallet`). */
  async loadWallet(name: string): Promise<void> {
    await this.call<{ name: string; warning?: string }>('loadwallet', [name], { base: true });
  }

  /** Names of the wallets currently loaded on the node (`listwallets`). */
  async listWallets(): Promise<string[]> {
    return this.call<string[]>('listwallets', [], { base: true });
  }

  /** A view of this client scoped to one wallet (see the constructor). */
  withWallet(name: string): RvnNode {
    return new RvnRpcClient(this.config, name);
  }

  async getInfo(): Promise<ChainInfo> {
    const r = await this.call<{ chain: string; blocks: number; connections: number }>(
      'getblockchaininfo',
      [],
      { base: true },
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
    /**
     * Ignored on the real client: ravend pays the issuance fee from the
     * wallet UTXO pool regardless of address, so per-agent isolation on
     * a real node is enforced at the funding-check layer, not at
     * execution (see getRvnBalance). The mock debits it (v0.41.0).
     */
    fromAddress?: string;
  }): Promise<string> {
    const units = opts.units ?? 0;
    const reissuable = opts.reissuable ?? true;
    // issue "asset_name" qty "to_address" units reissuable [ipfs_hash]
    const params: unknown[] = [opts.name, Number(opts.qty), opts.toAddress, units, reissuable];
    if (opts.ipfsHash) params.push(opts.ipfsHash);
    return this.call<string>('issue', params);
  }

  async transferAsset(assetName: string, qty: string, toAddress: string, _fromAddress?: string): Promise<string> {
    // transfer "asset_name" qty "to_address" — the miner fee comes from
    // the wallet pool and the asset moves from the wallet's holdings;
    // fromAddress is ignored here like on issue (see above), so on a
    // real node the funding check — which reads the agent's address —
    // is the enforcement point for per-agent asset isolation.
    return this.call<string>('transfer', [assetName, Number(qty), toAddress]);
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
    fromAddress?: string;
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
    fromAddress?: string;
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
    // listassets "( asset_name )" verbose — verbose=true returns per-asset objects.
    // The asset registry is chain-global, so this always uses the base
    // URL even on a wallet-scoped client (v0.43.0).
    const raw = await this.call<Record<string, { amount: number; units: number; reissuable: number; ipfs_hash?: string }>>(
      'listassets',
      [pattern, true],
      { base: true },
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
      }>('getassetdata', [name], { base: true });
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
   *
   * With an address (v0.42.0) the read scopes to that agent's wallet
   * address via `listassetbalancesbyaddress` (display amounts, so the
   * units come from `getassetdata` the same way) — the funding check's
   * asset leg is per-agent on a real node too, and the check is the
   * enforcement point there: ravend's `transfer` moves wallet-owned
   * assets regardless of address, so an agent whose address holds none
   * of the asset is refused at the gate instead of at execution. NOTE:
   * this path is implemented against the documented RPC shapes and is
   * not verified against a live ravend on this VM (no live node here)
   * — the mock leg is what the test suite exercises.
   */
  async getAssetBalance(assetName: string, address?: string): Promise<string | null> {
    const name = assetName.toUpperCase();
    if (address !== undefined) {
      const raw = await this.call<Record<string, number> | null>('listassetbalancesbyaddress', [address]);
      if (!raw) return null;
      const amount = raw[name];
      if (amount === undefined) return null;
      const data = await this.getAssetData(name);
      if (!data) return null;
      const balance = decimalToBaseUnits(amount, data.units);
      return BigInt(balance) > 0n ? balance : null;
    }
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
  async getRvnBalance(address?: string): Promise<string> {
    if (address === undefined) {
      const balance = await this.call<number>('getbalance');
      return decimalToBaseUnits(balance, 8);
    }
    // Per-agent wallet (v0.41.0): ravend has no per-address balance RPC,
    // so sum the address's UTXOs via `listunspent` (minconf 1). The
    // funding check reads this, so an agent whose address holds no RVN
    // is refused even when the shared wallet is funded — the check is
    // the enforcement point on a real node (the fee itself still comes
    // from the wallet pool at execution). NOTE: implemented against the
    // documented RPC shape and not verified against a live ravend on
    // this VM (no live node here) — the mock leg is what the test suite
    // exercises.
    const utxos = await this.call<Array<{ amount: number }>>('listunspent', [1, 9999999, [address]]);
    let total = 0n;
    for (const utxo of utxos ?? []) {
      total += BigInt(decimalToBaseUnits(utxo.amount, 8));
    }
    return total.toString();
  }

  /**
   * Confirmation target for the fee estimate: 6 blocks — a balance
   * between prompt confirmation and a stable rate. The estimate is
   * advisory (the funding check degrades to fee-only without it), so
   * the target is a constant, not operator policy.
   */
  async estimateFeeRateBaseUnitsPerKb(): Promise<string | null> {
    // ravend's estimatesmartfee returns { feerate, blocks } with the
    // rate in RVN per kilobyte, or an RPC error when the node has too
    // little fee data; some versions answer feerate -1 with an errors
    // list instead. Any of those means "cannot estimate" — null, never
    // a throw — so the funding check degrades to fee-only. NOTE: this
    // path is implemented against the documented RPC shape and is not
    // verified against a live ravend on this VM (no live node here) —
    // the mock leg and the stubbed-fetch units in `pnpm test:miner-fee`
    // are what the suite exercises.
    try {
      const r = await this.call<{ feerate?: number; blocks?: number; errors?: string[] }>(
        'estimatesmartfee',
        [6],
        { base: true },
      );
      if (!r || (Array.isArray(r.errors) && r.errors.length > 0)) return null;
      if (typeof r.feerate !== 'number' || !(r.feerate > 0)) return null;
      return decimalToBaseUnits(r.feerate, 8);
    } catch {
      return null;
    }
  }

  /**
   * Wallet balances: RVN plus every asset the wallet holds, via
   * `listmyassets` (verbose) + `getbalance`. A plain-number entry
   * falls back to `getassetdata` for the units, like getAssetBalance.
   * Zero-balance entries are skipped, matching the mock. With an
   * address (v0.41.0) the RVN figure is that address's balance (via
   * `listunspent`, see getRvnBalance) and the assets come from
   * `listassetbalancesbyaddress`; the asset list is still wallet-wide
   * in the no-address case. NOTE: this path is implemented against the
   * documented RPC shapes and is not verified against a live ravend on
   * this VM (no live node here) — the mock leg and the stubbed-fetch
   * units in `pnpm test:wallet` are what the suite exercises.
   */
  async listWalletBalances(address?: string): Promise<WalletBalances> {
    if (address !== undefined) {
      const raw = await this.call<Record<string, number> | null>('listassetbalancesbyaddress', [address]);
      const assets: WalletAssetBalance[] = [];
      for (const [name, amount] of Object.entries(raw ?? {})) {
        const data = await this.getAssetData(name);
        if (!data) continue;
        const balanceBaseUnits = decimalToBaseUnits(amount, data.units);
        if (BigInt(balanceBaseUnits) > 0n) {
          assets.push({ name, balanceBaseUnits, units: data.units });
        }
      }
      assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { rvnBaseUnits: await this.getRvnBalance(address), assets };
    }
    const raw = await this.call<Record<
      string,
      number | { amount: number; units: number }
    > | null>('listmyassets', ['*', true]);
    const assets: WalletAssetBalance[] = [];
    for (const [name, entry] of Object.entries(raw ?? {})) {
      let balanceBaseUnits: string;
      let units: number;
      if (typeof entry === 'number') {
        const data = await this.getAssetData(name);
        if (!data) continue;
        units = data.units;
        balanceBaseUnits = decimalToBaseUnits(entry, units);
      } else {
        units = entry.units;
        balanceBaseUnits = decimalToBaseUnits(entry.amount, units);
      }
      if (BigInt(balanceBaseUnits) > 0n) {
        assets.push({ name, balanceBaseUnits, units });
      }
    }
    assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { rvnBaseUnits: await this.getRvnBalance(), assets };
  }
}
