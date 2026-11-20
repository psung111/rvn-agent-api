/**
 * Balance-aware simulate (v0.36.0): the funding question behind a
 * simulation. The policy engine answers "may this intent run"; the
 * funding check answers "can the wallet pay for it".
 *
 *   - a transfer needs the wallet to hold at least qty of the asset
 *   - a supply-creating op (issue / reissue / sub-asset / unique) needs
 *     the wallet to hold enough RVN for the issuance fee
 *
 * The fees are Ravencoin consensus issuance fees, in RVN base units
 * (1 RVN = 10^8 base units): issue 500 RVN, reissue 100 RVN, sub-asset
 * 100 RVN, unique asset 5 RVN. They are chain constants, not policy —
 * the policy engine never sees them. The variable per-transaction miner
 * fee is NOT checked: it is small, node-dependent, and unknowable
 * before the transaction is built.
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
 * What the wallet must hold for this intent to execute: the asset (or
 * 'RVN' for a fee), the required amount in base units as a decimal
 * string, and the reason code reported when it cannot pay.
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
}

/**
 * Read-only funding check against the node. Never throws: a node error
 * is reported as `funded: null` with the error message, and the caller
 * keeps the policy decision.
 */
export async function checkFunding(intent: RvnIntent, node: RvnNode): Promise<FundingCheck> {
  const requirement = fundingRequirementFor(intent);
  try {
    const balance =
      requirement.asset === 'RVN'
        ? await node.getRvnBalance()
        : await node.getAssetBalance(requirement.asset);
    if (balance === null) {
      // The wallet holds none of the asset (or the asset is unknown):
      // that is a funding failure, not an unknown — a transfer of an
      // asset the wallet does not hold can never execute.
      return { ...requirement, balanceBaseUnits: null, funded: false };
    }
    const funded = BigInt(balance) >= BigInt(requirement.requiredBaseUnits);
    return { ...requirement, balanceBaseUnits: balance, funded };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...requirement, balanceBaseUnits: null, funded: null, error: message };
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
