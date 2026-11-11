/**
 * Policy domain types for Ravencoin asset operations.
 *
 * Quantities are decimal strings in the asset's base units (RVN itself uses
 * 10^8 base units per coin; issued assets use 10^units). Never floats.
 */

export type DecisionKind = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export type IntentKind = 'issue_asset' | 'transfer_asset' | 'reissue_asset' | 'issue_subasset' | 'issue_unique';

export interface RvnIntent {
  id: string;
  agentId: string;
  kind: IntentKind;
  /** Asset name, e.g. "MYCOIN". Required for both kinds. */
  assetName: string;
  /** Decimal string in the asset's base units. */
  qtyBaseUnits: string;
  /** Destination address. For issue/reissue: where the new supply goes. */
  destination: string;
  requestedAtMs: number;
  /**
   * Extra node params captured at submit time, replayed when the intent
   * executes — including after an approval hold. Intents serialize as JSON
   * in both stores, so optional fields here survive the round-trip.
   */
  execParams?: {
    /** issue: decimal places (default 0) */
    units?: number;
    /** issue: whether the asset stays reissuable (default true); reissue: flip the reissuable flag */
    reissuable?: boolean;
    /** issue: IPFS/Txid hash attached to the asset */
    ipfsHash?: string;
    /** reissue: replace the asset's decimal places (0..8) */
    newUnits?: number;
    /** reissue: replace the asset's IPFS/Txid hash */
    newIpfsHash?: string;
  };
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
  /**
   * Optional per-agent token-bucket rate limit (v0.18.0): bucket capacity
   * in operations, refilling fully over rateLimitWindowSeconds. Both
   * fields must be set together; either missing means unlimited, so older
   * policies without them keep working unchanged.
   */
  rateLimitMaxOps?: number;
  /** Window in seconds over which a full rate-limit bucket refills. */
  rateLimitWindowSeconds?: number;
  /**
   * Optional per-kind token-bucket rate limits (v0.21.0): a tighter
   * bucket for one operation kind, layered on top of the agent-wide
   * bucket when both are set — a submit must pass both, spending a
   * token from each. Each entry needs both maxOps and windowSeconds,
   * both positive integers; kinds absent from the map are unlimited
   * at the kind level, so older policies without this field keep
   * working unchanged.
   */
  rateLimitKindLimits?: Partial<
    Record<IntentKind, { maxOps: number; windowSeconds: number }>
  >;
  /**
   * Optional anomaly-detector thresholds (v0.22.0): tune the v0.12.0
   * hold-not-deny gate per agent instead of redeploying. Every field is
   * optional and falls back to its default when unset or malformed, so
   * older policies keep the exact behavior they had.
   */
  /** Qty must exceed this multiple of the same-kind median qty to flag (default 10). */
  anomalyQtyMultiple?: number;
  /** Minimum same-kind samples before a qty outlier can fire (default 3). */
  anomalyMinHistory?: number;
  /** Burst window in seconds for the first-seen-destination signal (default 3600). */
  anomalyBurstWindowSeconds?: number;
  /** Minimum intents in the burst window before a first-seen destination flags (default 3). */
  anomalyBurstMinCount?: number;
  /**
   * Optional multi-approver quorum (v0.27.0): a second, higher approval
   * threshold. Intents whose qty sits above the quorum threshold need
   * `quorumApprovals` distinct approvers instead of one; below it a
   * single approver still suffices. All three fields follow the
   * all-or-nothing rule: a count with no threshold (or vice versa) is
   * rejected on PUT / preset overrides, and a stored policy missing
   * either side degrades to no quorum, so older policies keep working
   * unchanged.
   */
  /** Distinct approvers required for a quorum hold (must be >= 2). */
  quorumApprovals?: number;
  /** Supply-creating qty above this needs quorum (issue/reissue/sub-asset/unique). */
  quorumAboveIssueQtyBaseUnits?: string;
  /** Transfer qty above this needs quorum. */
  quorumAboveTransferQtyBaseUnits?: string;
}

export interface Decision {
  intentId: string;
  agentId: string;
  kind: DecisionKind;
  reasonCodes: string[];
  decidedAtMs: number;
  expiresAtMs: number;
  /**
   * Multi-approver quorum (v0.27.0): distinct approvers required before
   * this held intent may execute. Set by the policy engine when the
   * intent's qty sits above the policy's quorum threshold; absent means
   * the normal single-approver flow. The stored decision is the authority
   * at approval time, so a policy change after the hold cannot silently
   * drop or add a quorum.
   */
  quorumRequired?: number;
  /**
   * Approver identities recorded so far for a quorum hold (distinct
   * strings — the same approver approving twice counts once). Persisted
   * with the decision, so a restart cannot lose the count.
   */
  approvals?: string[];
}

/** Minimal rolling-window ledger. Async so a Postgres implementation can serve it. */
export interface IssueLedger {
  recordIssue(agentId: string, qtyBaseUnits: bigint, atMs: number): Promise<void>;
  issuedInWindow(agentId: string, windowMs: number, nowMs: number): Promise<bigint>;
}
