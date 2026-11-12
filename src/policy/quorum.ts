import type { RvnPolicy } from './types.js';

/**
 * Multi-approver quorum (v0.27.0, slice 1; roster in v0.28.0, slice 2): a
 * second, higher approval threshold in policy. Intents whose qty sits above
 * the quorum threshold need N distinct approvers instead of one — a single
 * approver still suffices below it, so existing flows are unchanged.
 *
 * The roster (M) is the quorum's approver pool: an optional policy-defined
 * set of approver identities. When a roster is set, only its members count
 * toward quorum — an approval from anyone else is rejected (403) and the
 * count does not move — and a pending hold reports n/N of M. A quorum
 * without a roster keeps the v0.27.0 behavior: any N distinct approvers
 * count. The roster is snapshotted onto the decision at hold time, so a
 * policy change after the hold can neither add nor remove approvers from
 * that hold.
 *
 * Follows the established lenient/strict split (see anomaly.ts,
 * ratelimit.ts): stored policies parse leniently — a malformed quorum
 * config degrades to "no quorum", never a crash — while PUT and
 * preset-override writes validate strictly.
 */

export interface QuorumConfig {
  /** Distinct approvers required before a quorum hold may execute (>= 2). */
  approvals: number;
  /** Supply-creating qty above this needs quorum (issue/reissue/sub-asset/unique). */
  issueThreshold?: bigint;
  /** Transfer qty above this needs quorum. */
  transferThreshold?: bigint;
  /**
   * Approver roster (M): only these identities count toward quorum.
   * Absent means any distinct approvers count (v0.27.0 behavior).
   */
  approvers?: string[];
}

type QuorumFields = Pick<
  RvnPolicy,
  'quorumApprovals' | 'quorumAboveIssueQtyBaseUnits' | 'quorumAboveTransferQtyBaseUnits' | 'quorumApprovers'
>;

/**
 * Lenient roster normalization for stored policies: the value must be an
 * array; entries are trimmed, non-string or empty entries are dropped,
 * and duplicates are removed (first occurrence wins). A value that is not
 * an array, or that normalizes to nothing, means "no roster" — never a
 * crash, and never an empty roster that could silently block every
 * approver.
 */
export function normalizeRoster(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const roster: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    roster.push(trimmed);
  }
  return roster.length > 0 ? roster : undefined;
}

function parseThreshold(value: string | undefined): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const n = BigInt(value);
    return n >= 0n ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lenient parse for stored policies: quorum is active only when the
 * approval count is an integer >= 2 AND at least one threshold parses.
 * Anything else — missing count, a count of 1 (a quorum of one is just
 * the normal single-approver flow), malformed thresholds, no threshold
 * at all — degrades to "no quorum", never a crash.
 */
export function quorumConfigFromPolicy(policy: Partial<QuorumFields>): QuorumConfig | undefined {
  const approvals = policy.quorumApprovals;
  if (typeof approvals !== 'number' || !Number.isInteger(approvals) || approvals < 2) {
    return undefined;
  }
  const issueThreshold = parseThreshold(policy.quorumAboveIssueQtyBaseUnits);
  const transferThreshold = parseThreshold(policy.quorumAboveTransferQtyBaseUnits);
  if (issueThreshold === undefined && transferThreshold === undefined) return undefined;
  // The roster rides along when it normalizes to a non-empty list; a
  // roster smaller than the required count stays active (fail-safe: the
  // hold can never complete until the policy is fixed, rather than
  // silently degrading a high-value hold to single-approver). Strict
  // validation on writes prevents that config from being stored.
  const approvers = normalizeRoster(policy.quorumApprovers);
  return { approvals, issueThreshold, transferThreshold, ...(approvers ? { approvers } : {}) };
}

/**
 * Strict validation for PUT / preset-override writes: returns an error
 * string, or undefined when valid. Quorum is all-or-nothing — a count
 * with no threshold (or a threshold or roster with no count) is a
 * half-configured quorum, so it is rejected rather than silently treated
 * as no quorum. A count below 2 is rejected too: a quorum of one is the
 * default flow, and accepting it would silently downgrade an intended
 * quorum. The roster, when set, must be a non-empty array of non-empty
 * identity strings, and at least as large as the required count — a
 * quorum that can never be met is a config error, not a policy.
 */
export function validateQuorumFields(policy: Partial<QuorumFields>): string | undefined {
  const { quorumApprovals, quorumAboveIssueQtyBaseUnits, quorumAboveTransferQtyBaseUnits, quorumApprovers } = policy;
  const anySet =
    quorumApprovals !== undefined ||
    quorumAboveIssueQtyBaseUnits !== undefined ||
    quorumAboveTransferQtyBaseUnits !== undefined ||
    quorumApprovers !== undefined;
  if (!anySet) return undefined;
  if (quorumApprovals === undefined) {
    return 'quorumApprovals is required when a quorum threshold or approver roster is set';
  }
  if (typeof quorumApprovals !== 'number' || !Number.isInteger(quorumApprovals) || quorumApprovals < 2) {
    return 'quorumApprovals must be an integer of at least 2 when set';
  }
  if (quorumAboveIssueQtyBaseUnits === undefined && quorumAboveTransferQtyBaseUnits === undefined) {
    return 'at least one quorum threshold (quorumAboveIssueQtyBaseUnits or quorumAboveTransferQtyBaseUnits) is required when quorumApprovals is set';
  }
  for (const [name, value] of [
    ['quorumAboveIssueQtyBaseUnits', quorumAboveIssueQtyBaseUnits],
    ['quorumAboveTransferQtyBaseUnits', quorumAboveTransferQtyBaseUnits],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || parseThreshold(value) === undefined) {
      return `${name} must be a non-negative integer decimal string when set`;
    }
  }
  if (quorumApprovers !== undefined) {
    if (!Array.isArray(quorumApprovers)) {
      return 'quorumApprovers must be an array of approver identity strings when set';
    }
    const roster = normalizeRoster(quorumApprovers);
    if (roster === undefined) {
      return 'quorumApprovers must contain at least one non-empty approver identity when set';
    }
    if (quorumApprovals > roster.length) {
      return `quorumApprovals (${quorumApprovals}) exceeds the approver roster size (${roster.length}) — a quorum that can never be met`;
    }
  }
  return undefined;
}
