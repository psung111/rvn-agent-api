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
  listAssets(pattern?: string): Promise<AssetInfo[]>;
  getAssetData(name: string): Promise<AssetInfo | null>;
}
