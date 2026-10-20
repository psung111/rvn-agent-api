/**
 * Policy domain types for Ravencoin asset operations.
 *
 * Quantities are decimal strings in the asset's base units (RVN itself uses
 * 10^8 base units per coin; issued assets use 10^units). Never floats.
 */

export type DecisionKind = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export type IntentKind = 'issue_asset' | 'transfer_asset';

export interface RvnIntent {
  id: string;
  agentId: string;
  kind: IntentKind;
  /** Asset name, e.g. "MYCOIN". Required for both kinds. */
  assetName: string;
  /** Decimal string in the asset's base units. */
  qtyBaseUnits: string;
  /** Destination address. For issue: where the new supply goes. */
  destination: string;
  requestedAtMs: number;
}

export interface RvnPolicy {
  version: 1;
  agentId: string; // specific agent, or '*' for default
  /** Per-operation issue ceiling. Above -> DENY. */
  maxIssueQtyBaseUnits: string;
  /** Issue qty above this -> REQUIRE_APPROVAL. */
  approvalAboveIssueQtyBaseUnits: string;
  /** Rolling 24h issue budget per agent. Above -> DENY. */
  dailyIssueBudgetBaseUnits: string;
  /** Per-operation transfer ceiling. Above -> DENY. */
  maxTransferQtyBaseUnits: string;
  /** Transfer qty above this -> REQUIRE_APPROVAL. */
  approvalAboveTransferQtyBaseUnits: string;
  /** RVN addresses, or ['*']. Unknown destination -> REQUIRE_APPROVAL. */
  allowedDestinations: string[];
  /** Always DENY, no exceptions. */
  blockedDestinations: string[];
  /** Regex source asset names must match, e.g. '^[A-Z0-9._]{3,30}$'. Non-match -> DENY. */
  assetNamePattern: string;
  /** How long an ALLOW / REQUIRE_APPROVAL decision stays valid. */
  decisionTtlSeconds: number;
}

export interface Decision {
  intentId: string;
  agentId: string;
  kind: DecisionKind;
  reasonCodes: string[];
  decidedAtMs: number;
  expiresAtMs: number;
}

/** Minimal rolling-window ledger. Swap for Postgres when this grows up. */
export interface IssueLedger {
  recordIssue(agentId: string, qtyBaseUnits: bigint, atMs: number): void;
  issuedInWindow(agentId: string, windowMs: number, nowMs: number): bigint;
}
