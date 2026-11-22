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
  issueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    units?: number;
    reissuable?: boolean;
    ipfsHash?: string;
  }): Promise<string>; // txid
  transferAsset(assetName: string, qty: string, toAddress: string): Promise<string>; // txid
  reissueAsset(opts: {
    name: string;
    qty: string;
    toAddress: string;
    reissuable?: boolean;
    newUnits?: number;
    newIpfsHash?: string;
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
   */
  getAssetBalance(assetName: string): Promise<string | null>;
  getRvnBalance(): Promise<string>;

  /**
   * Wallet balances for GET /v1/wallet/balances (v0.38.0): the wallet's
   * RVN balance plus every asset balance it holds, so an operator or
   * monitoring agent can see what the wallet can fund without
   * simulating an intent for each asset. Read-only. Only assets with a
   * nonzero wallet balance are listed — an asset fully transferred out
   * disappears from the list (same as ravend's `listmyassets`).
   */
  listWalletBalances(): Promise<WalletBalances>;
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
