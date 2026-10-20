import type { Decision, IssueLedger, RvnIntent, RvnPolicy } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const norm = (s: string) => s.trim().toLowerCase();

/** In-memory rolling-window ledger. Phase 2: Postgres. */
export class InMemoryIssueLedger implements IssueLedger {
  private issues = new Map<string, Array<{ atMs: number; qty: bigint }>>();

  recordIssue(agentId: string, qtyBaseUnits: bigint, atMs: number): void {
    const list = this.issues.get(agentId) ?? [];
    list.push({ atMs, qty: qtyBaseUnits });
    this.issues.set(agentId, list);
  }

  issuedInWindow(agentId: string, windowMs: number, nowMs: number): bigint {
    const cutoff = nowMs - windowMs;
    const list = this.issues.get(agentId) ?? [];
    const fresh = list.filter((s) => s.atMs >= cutoff);
    this.issues.set(agentId, fresh);
    return fresh.reduce((sum, s) => sum + s.qty, 0n);
  }
}

function decide(
  intent: RvnIntent,
  kind: Decision['kind'],
  reasonCodes: string[],
  policy: RvnPolicy,
  nowMs: number,
): Decision {
  return {
    intentId: intent.id,
    agentId: intent.agentId,
    kind,
    reasonCodes,
    decidedAtMs: nowMs,
    expiresAtMs: nowMs + policy.decisionTtlSeconds * 1000,
  };
}

export function isExpired(decision: Decision, nowMs: number = Date.now()): boolean {
  return nowMs > decision.expiresAtMs;
}

/**
 * Deterministic evaluation:
 *   1. Hard denies — blocked destination, bad asset name, per-op caps, daily budget
 *   2. Approval routing — unknown destination, above approval thresholds
 *   3. Allow
 */
export function evaluateIntent(
  intent: RvnIntent,
  policy: RvnPolicy,
  ledger: IssueLedger,
  nowMs: number = Date.now(),
): Decision {
  const qty = BigInt(intent.qtyBaseUnits);
  const dest = norm(intent.destination);

  // ---- Stage 1: hard denies ----
  if (policy.blockedDestinations.some((d) => norm(d) === dest)) {
    return decide(intent, 'DENY', ['DESTINATION_BLOCKED'], policy, nowMs);
  }

  if (!new RegExp(policy.assetNamePattern).test(intent.assetName)) {
    return decide(intent, 'DENY', ['ASSET_NAME_REJECTED'], policy, nowMs);
  }

  if (qty <= 0n) {
    return decide(intent, 'DENY', ['NON_POSITIVE_QTY'], policy, nowMs);
  }

  if (intent.kind === 'issue_asset') {
    if (qty > BigInt(policy.maxIssueQtyBaseUnits)) {
      return decide(intent, 'DENY', ['ISSUE_CAP_EXCEEDED'], policy, nowMs);
    }
    const issued24h = ledger.issuedInWindow(intent.agentId, DAY_MS, nowMs);
    if (issued24h + qty > BigInt(policy.dailyIssueBudgetBaseUnits)) {
      return decide(intent, 'DENY', ['DAILY_ISSUE_BUDGET_EXCEEDED'], policy, nowMs);
    }
  } else {
    if (qty > BigInt(policy.maxTransferQtyBaseUnits)) {
      return decide(intent, 'DENY', ['TRANSFER_CAP_EXCEEDED'], policy, nowMs);
    }
  }

  // ---- Stage 2: approval routing ----
  const destinationKnown =
    policy.allowedDestinations.includes('*') ||
    policy.allowedDestinations.some((d) => norm(d) === dest);
  if (!destinationKnown) {
    return decide(intent, 'REQUIRE_APPROVAL', ['DESTINATION_NOT_ALLOWLISTED'], policy, nowMs);
  }

  const approvalThreshold =
    intent.kind === 'issue_asset'
      ? BigInt(policy.approvalAboveIssueQtyBaseUnits)
      : BigInt(policy.approvalAboveTransferQtyBaseUnits);
  if (qty > approvalThreshold) {
    return decide(intent, 'REQUIRE_APPROVAL', ['ABOVE_APPROVAL_THRESHOLD'], policy, nowMs);
  }

  // ---- Stage 3: allow ----
  return decide(intent, 'ALLOW', ['WITHIN_POLICY'], policy, nowMs);
}
