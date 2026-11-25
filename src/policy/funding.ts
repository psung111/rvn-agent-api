/**
 * Balance-aware simulate (v0.36.0): the funding question behind a
 * simulation. The policy engine answers "may this intent run"; the
 * funding check answers "can the wallet pay for it".
 *
 *   - a transfer needs the wallet to hold at least qty of the asset
 *   - a supply-creating op (issue / reissue / sub-asset / unique) needs
 *     the wallet to hold enough RVN for the issuance fee
 *
 * Since v0.41.0 the RVN legs read the submitting agent's own wallet
 * address (when the server resolved one) instead of the wallet-wide
 * balance, so one agent's fees cannot drain what another agent
 * simulates against; the asset leg is still wallet-wide in this slice.
 *
 * The fees are Ravencoin consensus issuance fees, in RVN base units
 * (1 RVN = 10^8 base units): issue 500 RVN, reissue 100 RVN, sub-asset
 * 100 RVN, unique asset 5 RVN. They are chain constants, not policy —
 * the policy engine never sees them.
 *
 * On top of the issuance fee, every transaction pays a variable
 * per-transaction miner fee (v0.39.0): the node is asked for its current
 * fee rate (`estimatesmartfee`, base units per kilobyte) and the fee is
 * estimated from the transaction size for the op kind. A supply-creating
 * op needs RVN for fee + miner fee; a transfer needs the asset qty plus
 * enough RVN for the miner fee. A wallet holding exactly the issuance
 * fee but no room for the miner fee is unfunded — it used to simulate as
 * funded and then fail at execution. When the node cannot estimate a
 * rate, the check degrades to the issuance fee / asset qty alone.
 *
 * The check is read-only (balance lookups only) and runs only when the
 * policy decision is ALLOW: a policy DENY or hold is reported as-is,
 * and a node that cannot answer leaves the decision untouched with
 * `funded: null` instead of failing the simulation.
 */
import type { RvnNode } from '../rvn/types.js';
import type { Decision, RvnIntent } from './types.js';

/** Base units (satoshis) per RVN. */
export const RVN_BASE_UNITS_PER_COIN = 100_000_000n;

/**
 * Issuance fees in RVN base units. Ravencoin consensus: issuing a new
 * asset costs 500 RVN, reissuing 100 RVN, issuing a sub-asset 100 RVN,
 * issuing a unique asset 5 RVN.
 */
export const ISSUANCE_FEE_BASE_UNITS = {
  issue_asset: 500n * RVN_BASE_UNITS_PER_COIN,
  reissue_asset: 100n * RVN_BASE_UNITS_PER_COIN,
  issue_subasset: 100n * RVN_BASE_UNITS_PER_COIN,
  issue_unique: 5n * RVN_BASE_UNITS_PER_COIN,
} as const satisfies Record<
  'issue_asset' | 'reissue_asset' | 'issue_subasset' | 'issue_unique',
  bigint
>;

export type FundingReasonCode = 'INSUFFICIENT_ASSET_BALANCE' | 'INSUFFICIENT_RVN_BALANCE';

/**
 * Estimated transaction size in virtual bytes per op kind. A 1-input
 * P2PKH Ravencoin asset transaction is ~250 vB (a ~148 vB input, a
 * ~60 vB OP_RVN_ASSET output, a ~34 vB change output, ~10 vB overhead);
 * the estimates pad for a second input or a larger asset script, so the
 * miner-fee estimate is conservative — it never understates the fee the
 * node will actually charge. These are estimates, not consensus values:
 * the exact size is knowable only once the transaction is built.
 */
export const ESTIMATED_TX_SIZE_VBYTES = {
  issue_asset: 500,
  reissue_asset: 400,
  issue_subasset: 500,
  issue_unique: 400,
  transfer_asset: 350,
} as const satisfies Record<RvnIntent['kind'], number>;

/**
 * Estimated miner fee in RVN base units for an op at a fee rate of
 * `rateBaseUnitsPerKb` base units per kilobyte. Ceiling division: a
 * partial kilobyte still pays the per-byte rate, so the estimate never
 * comes in under the fee the node will charge for the estimated size.
 */
export function estimateMinerFeeBaseUnits(
  kind: RvnIntent['kind'],
  rateBaseUnitsPerKb: string,
): string {
  const rate = BigInt(rateBaseUnitsPerKb);
  const size = BigInt(ESTIMATED_TX_SIZE_VBYTES[kind]);
  return ((rate * size + 999n) / 1000n).toString();
}

/**
 * The miner-fee leg of a funding check: the estimated fee for this op,
 * from the node's fee rate and the estimated transaction size. When the
 * node cannot estimate a rate, `requiredBaseUnits` and
 * `rateBaseUnitsPerKb` are null and the check degrades to the issuance
 * fee / asset qty alone.
 */
export interface MinerFeeEstimate {
  /** Estimated miner fee in RVN base units, or null when unestimable. */
  requiredBaseUnits: string | null;
  /** Fee rate behind the estimate, RVN base units per kilobyte; null when unestimable. */
  rateBaseUnitsPerKb: string | null;
  /** Estimated transaction size in virtual bytes for this op kind. */
  estimatedTxSizeVbytes: number;
  /**
   * Wallet RVN balance in base units — only for transfers, whose miner
   * fee is a separate RVN requirement from the asset qty; null when the
   * node could not answer. Omitted for supply-creating ops, where the
   * top-level balance already is the RVN balance.
   */
  balanceBaseUnits?: string | null;
  /** Node error message when the fee rate could not be read. */
  error?: string;
}

/**
 * What the wallet must hold for this intent to execute: the asset (or
 * 'RVN' for a fee), the required amount in base units as a decimal
 * string, and the reason code reported when it cannot pay. This is the
 * base requirement — the issuance fee (or the asset qty) — before the
 * miner fee: `checkFunding` adds the estimated miner fee on top for
 * RVN requirements, and checks it as a second leg for transfers.
 */
export interface FundingRequirement {
  /** Asset name, or 'RVN' when the requirement is the issuance fee. */
  asset: string;
  /** Required amount in base units (decimal string). */
  requiredBaseUnits: string;
  reasonCode: FundingReasonCode;
}

export function fundingRequirementFor(intent: RvnIntent): FundingRequirement {
  if (intent.kind === 'transfer_asset') {
    return {
      asset: intent.assetName,
      requiredBaseUnits: intent.qtyBaseUnits,
      reasonCode: 'INSUFFICIENT_ASSET_BALANCE',
    };
  }
  return {
    asset: 'RVN',
    requiredBaseUnits: ISSUANCE_FEE_BASE_UNITS[intent.kind].toString(),
    reasonCode: 'INSUFFICIENT_RVN_BALANCE',
  };
}

/**
 * The outcome of the funding check, carried on the simulate response.
 * `balanceBaseUnits` is null when the node could not answer (unknown
 * asset for a transfer, or a node error); `funded` is null in the same
 * cases — unknown, not denied — so a node failure never flips a policy
 * ALLOW into a DENY.
 */
export interface FundingCheck {
  /** Asset name, or 'RVN' when the requirement is the issuance fee. */
  asset: string;
  /** Required amount in base units (decimal string). */
  requiredBaseUnits: string;
  /** Wallet balance in base units (decimal string), or null when unknown. */
  balanceBaseUnits: string | null;
  /** True when the wallet can fund the intent, false when it cannot, null when unknown. */
  funded: boolean | null;
  /** Reason code reported when funded is false. */
  reasonCode: FundingReasonCode;
  /** Node error message when the balance could not be read; never a secret. */
  error?: string;
  /**
   * The miner-fee leg of the check. Always present on checks produced by
   * `checkFunding`; optional here so hand-built checks (tests) may omit it.
   */
  minerFee?: MinerFeeEstimate;
}

/**
 * Read-only funding check against the node. Never throws: a node error
 * is reported as `funded: null` with the error message, and the caller
 * keeps the policy decision.
 *
 * `walletAddress` (v0.41.0) is the agent's own wallet address: the RVN
 * legs read that address's balance instead of the wallet-wide one, so
 * one agent's issue fee cannot drain the balance another agent
 * simulates against. Omit it (simulate before any address exists, or
 * a caller that could not resolve one) for the wallet-wide balance, as
 * before. The asset leg stays wallet-wide in this slice — per-address
 * asset balances are the next slice of per-agent wallets.
 *
 * The miner fee rides on top of the base requirement. For a
 * supply-creating op the RVN requirement is issuance fee + estimated
 * miner fee, so a wallet holding exactly the issuance fee is unfunded.
 * For a transfer the asset qty stays the top-level requirement and the
 * miner fee is checked as a second, RVN-denominated leg — the asset leg
 * runs first, so a transfer the wallet cannot fund on the asset side
 * never spends a node call on the RVN side. When the node cannot
 * estimate a fee rate (too little fee data, a throwing estimate, or a
 * node without the method), the check degrades to the base requirement
 * alone and the miner-fee leg reports nulls instead of failing the
 * simulation.
 */
export async function checkFunding(
  intent: RvnIntent,
  node: RvnNode,
  walletAddress?: string,
): Promise<FundingCheck> {
  const requirement = fundingRequirementFor(intent);
  const estimatedTxSizeVbytes = ESTIMATED_TX_SIZE_VBYTES[intent.kind];
  // The fee rate is advisory: an unestimable rate degrades the check to
  // the base requirement, never a throw and never a flipped ALLOW.
  let rateBaseUnitsPerKb: string | null = null;
  let rateError: string | undefined;
  try {
    if (typeof node.estimateFeeRateBaseUnitsPerKb === 'function') {
      const rate = await node.estimateFeeRateBaseUnitsPerKb();
      if (rate !== null && /^\d+$/.test(rate)) rateBaseUnitsPerKb = rate;
      else if (rate !== null) rateError = `malformed fee rate: ${rate}`;
    }
  } catch (err) {
    rateError = err instanceof Error ? err.message : String(err);
    rateBaseUnitsPerKb = null;
  }
  const minerFeeBaseUnits =
    rateBaseUnitsPerKb === null ? null : estimateMinerFeeBaseUnits(intent.kind, rateBaseUnitsPerKb);
  const minerFee: MinerFeeEstimate = {
    requiredBaseUnits: minerFeeBaseUnits,
    rateBaseUnitsPerKb,
    estimatedTxSizeVbytes,
    ...(rateError !== undefined ? { error: rateError } : {}),
  };

  if (requirement.asset === 'RVN') {
    // Supply-creating op: one RVN requirement — issuance fee + miner fee.
    // The balance is the agent's own wallet address when known (v0.41.0).
    const required =
      minerFeeBaseUnits === null
        ? requirement.requiredBaseUnits
        : (BigInt(requirement.requiredBaseUnits) + BigInt(minerFeeBaseUnits)).toString();
    try {
      const balance = await node.getRvnBalance(walletAddress);
      return {
        ...requirement,
        requiredBaseUnits: required,
        balanceBaseUnits: balance,
        funded: BigInt(balance) >= BigInt(required),
        minerFee,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...requirement,
        requiredBaseUnits: required,
        balanceBaseUnits: null,
        funded: null,
        error: message,
        minerFee,
      };
    }
  }

  // Transfer: the asset qty is the top-level requirement; the miner fee
  // is a second RVN leg, checked only once the asset leg passes.
  try {
    const balance = await node.getAssetBalance(requirement.asset);
    if (balance === null || BigInt(balance) < BigInt(requirement.requiredBaseUnits)) {
      // The wallet holds none of the asset (or too little of it): that is
      // a funding failure, not an unknown — a transfer the wallet cannot
      // cover on the asset side can never execute.
      return { ...requirement, balanceBaseUnits: balance, funded: false, minerFee };
    }
    if (minerFeeBaseUnits === null) {
      return { ...requirement, balanceBaseUnits: balance, funded: true, minerFee };
    }
    try {
      const rvnBalance = await node.getRvnBalance(walletAddress);
      const rvnFunded = BigInt(rvnBalance) >= BigInt(minerFeeBaseUnits);
      return {
        ...requirement,
        balanceBaseUnits: balance,
        funded: rvnFunded,
        ...(rvnFunded ? {} : { reasonCode: 'INSUFFICIENT_RVN_BALANCE' }),
        minerFee: { ...minerFee, balanceBaseUnits: rvnBalance },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...requirement,
        balanceBaseUnits: balance,
        funded: null,
        minerFee: { ...minerFee, balanceBaseUnits: null, error: message },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...requirement, balanceBaseUnits: null, funded: null, error: message, minerFee };
  }
}

/**
 * Apply a funding check to a policy-ALLOW decision: an unfunded intent
 * becomes a DENY carrying only the funding reason code (same intent,
 * agent, and TTL window — the decision is still the simulation's
 * answer, now with the funding verdict). A funded or unknown check
 * leaves the decision untouched.
 */
export function applyFunding(decision: Decision, funding: FundingCheck): Decision {
  if (funding.funded !== false) return decision;
  return { ...decision, kind: 'DENY', reasonCodes: [funding.reasonCode] };
}
