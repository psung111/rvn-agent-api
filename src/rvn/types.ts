export interface AssetInfo {
  name: string;
  /** Decimal string in the asset's base units. */
  amount: string;
  units: number;
  reissuable: boolean;
  ipfsHash?: string;
}

export interface ChainInfo {
  chain: string;
  blocks: number;
  connections: number;
}

/**
 * The only surface the API needs from a Ravencoin node. Implemented by the
 * real JSON-RPC client and by the in-memory mock — the API can't tell them apart.
 */
export interface RvnNode {
  getInfo(): Promise<ChainInfo>;
  getNewAddress(label?: string): Promise<string>;
  /**
   * `fromAddress` (v0.41.0) is the agent wallet the issuance fee and the
   * estimated miner fee are debited from. The mock debits that address
   * (seeded on provisioning); the real client ignores it — ravend pays
   * fees from the wallet UTXO pool regardless of address, so per-agent
   * isolation on a real node is enforced at the funding-check layer,
   * not at execution. Omit it and the mock debits its operator address.
   */
  issueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
    fromAddress?: string;
  }): Promise<string>; // txid
  transferAsset(assetName: string, qty: string, toAddress: string, fromAddress?: string): Promise<string>; // txid
  reissueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    reissuable?: boolean;
    newUnits?: number;
    newIpfsHash?: string;
    fromAddress?: string;
  }): Promise<string>; // txid
  /**
   * Issue a sub-asset: name is PARENT[/CHILD...] and the immediate parent
   * must already exist. ravend issues sub-assets through the same `issue`
   * RPC, so the real client delegates there; the mock enforces the
   * parent-exists rule explicitly.
   */
  issueSubAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
    fromAddress?: string;
  }): Promise<string>; // txid
  /**
   * Issue a unique asset: name is ROOT#TAG and the root asset must already
   * exist. A unique asset is a singleton — amount 1, units 0, not
   * reissuable — so there is no qty: ravend's `issueunique` takes the root
   * name and a tag list, not a quantity. The real client issues one tag
   * per call; the mock enforces root-exists and tag-shape rules explicitly.
   */
  issueUniqueAsset(opts: {
    name: string;
    toAddress: string;
    ipfsHash?: string;
    fromAddress?: string;
  }): Promise<string>; // txid
  listAssets(pattern?: string): Promise<AssetInfo[]>;
  getAssetData(name: string): Promise<AssetInfo | null>;
  /**
   * Wallet balances for the funding check behind simulate (v0.36.0).
   * `getAssetBalance` is the wallet's holding of one asset in base
   * units — null when the wallet holds none of it (unknown asset
   * included). `getRvnBalance` is the wallet's RVN balance in base
   * units (1 RVN = 10^8). Both are read-only: simulate calls them and
   * never moves funds.
   *
   * `getRvnBalance(address)` (v0.41.0) scopes the RVN read to one
   * agent's wallet address — the mock reads that address's balance
   * ('0' when the mock knows nothing about it), the real client sums
   * the address's UTXOs via `listunspent`. Omit the address for the
   * wallet-wide balance, as before.
   */
  getAssetBalance(assetName: string): Promise<string | null>;
  getRvnBalance(address?: string): Promise<string>;

  /**
   * Current fee rate in RVN base units per kilobyte, via
   * `estimatesmartfee` (v0.39.0) — the rate the funding check uses to
   * estimate the per-transaction miner fee. Null when the node cannot
   * estimate (too little fee data, or the RPC fails): the funding check
   * degrades to the issuance fee / asset qty alone instead of failing.
   * Read-only.
   */
  estimateFeeRateBaseUnitsPerKb(): Promise<string | null>;

  /**
   * Wallet balances for GET /v1/wallet/balances (v0.38.0): the wallet's
   * RVN balance plus every asset balance it holds, so an operator or
   * monitoring agent can see what the wallet can fund without
   * simulating an intent for each asset. Read-only. Only assets with a
   * nonzero wallet balance are listed — an asset fully transferred out
   * disappears from the list (same as ravend's `listmyassets`).
   *
   * `listWalletBalances(address)` (v0.41.0) scopes the RVN balance to
   * one agent's wallet address; the asset list stays wallet-wide until
   * per-address asset balances land (slice 2 of per-agent wallets).
   */
  listWalletBalances(address?: string): Promise<WalletBalances>;
}

/** One asset balance in the wallet, in base units (decimal string). */
export interface WalletAssetBalance {
  name: string;
  /** Wallet balance in base units (decimal string). */
  balanceBaseUnits: string;
  /** Decimal places of the asset. */
  units: number;
}

/** The wallet's balances: RVN plus every held asset, assets sorted by name. */
export interface WalletBalances {
  /** Wallet RVN balance in base units (decimal string). */
  rvnBaseUnits: string;
  /** Every asset the wallet holds (nonzero balance only), sorted by name. */
  assets: WalletAssetBalance[];
}
