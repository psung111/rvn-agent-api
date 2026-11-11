import type { RvnPolicy } from './types.js';

/**
 * Multi-approver quorum (v0.27.0, slice 1): a second, higher approval
 * threshold in policy. Intents whose qty sits above the quorum threshold
 * need N distinct approvers instead of one — a single approver still
 * suffices below it, so existing flows are unchanged.
 *
 * The quorum is a policy dimension, not a separate mechanism: the policy
 * engine marks the decision with `quorumRequired: N` (and reason code
 * QUORUM_REQUIRED when the quorum threshold is the only reason for the
 * hold), and the approval path counts distinct approver identities until
 * N is reached. Deny stays single-approver: any one approver can still
 * kill a hold outright.
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
}

type QuorumFields = Pick<
  RvnPolicy,
  'quorumApprovals' | 'quorumAboveIssueQtyBaseUnits' | 'quorumAboveTransferQtyBaseUnits'
>;

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
  return { approvals, issueThreshold, transferThreshold };
}

/**
 * Strict validation for PUT / preset-override writes: returns an error
 * string, or undefined when valid. Quorum is all-or-nothing — a count
 * with no threshold (or a threshold with no count) is a half-configured
 * quorum, so it is rejected rather than silently treated as no quorum.
 * A count below 2 is rejected too: a quorum of one is the default flow,
 * and accepting it would silently downgrade an intended quorum.
 */
export function validateQuorumFields(policy: Partial<QuorumFields>): string | undefined {
  const { quorumApprovals, quorumAboveIssueQtyBaseUnits, quorumAboveTransferQtyBaseUnits } = policy;
  const anySet =
    quorumApprovals !== undefined ||
    quorumAboveIssueQtyBaseUnits !== undefined ||
    quorumAboveTransferQtyBaseUnits !== undefined;
  if (!anySet) return undefined;
  if (quorumApprovals === undefined) {
    return 'quorumApprovals is required when a quorum threshold is set';
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
  return undefined;
}
