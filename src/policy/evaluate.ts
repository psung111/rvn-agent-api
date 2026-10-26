import type { Decision, IssueLedger, RvnIntent, RvnPolicy } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const norm = (s: string) => s.trim().toLowerCase();

/**
 * Issue, reissue, sub-asset, and unique-asset issuance all create new
 * supply, so they share the same policy dimensions: per-op issue cap,
 * rolling 24h issue budget, and the issue approval threshold (with the
 * ISSUE_* reason codes). A unique asset always counts 1 against the budget.
 */
export function createsSupply(kind: RvnIntent['kind']): boolean {
  return kind === 'issue_asset' || kind === 'reissue_asset' || kind === 'issue_subasset' || kind === 'issue_unique';
}

/**
 * Asset-name check against the policy pattern. Plain and reissued assets
 * match the pattern as a whole; a sub-asset name is `PARENT[/CHILD...]`,
 * so every slash-separated segment must match the pattern and there must
 * be at least two segments (a bare parent is an issue, not a sub-asset).
 * A unique asset is `ROOT#TAG` (the root may itself be a sub-asset, e.g.
 * `ART/DAVINCI#MONALISA`): every slash-separated segment of the root must
 * match the pattern, there must be exactly one '#', and the tag — whose
 * on-chain charset is wider than root names — must be 1..30 chars of
 * letters, digits, '.', '_' or '-'.
 */
export function nameMatchesPattern(
  kind: RvnIntent['kind'],
  name: string,
  pattern: string,
): boolean {
  const re = new RegExp(pattern);
  if (kind === 'issue_unique') {
    const parts = name.split('#');
    if (parts.length !== 2) return false;
    const [root, tag] = parts;
    if (!/^[A-Za-z0-9._-]{1,30}$/.test(tag)) return false;
    const segments = root.split('/');
    return segments.length >= 1 && segments.every((s) => re.test(s));
  }
  if (kind !== 'issue_subasset') return re.test(name);
  const segments = name.split('/');
  return segments.length >= 2 && segments.every((s) => re.test(s));
}

/** In-memory rolling-window ledger. The Postgres equivalent lives in src/store. */
export class InMemoryIssueLedger implements IssueLedger {
  private issues = new Map<string, Array<{ atMs: number; qty: bigint }>>();

  async recordIssue(agentId: string, qtyBaseUnits: bigint, atMs: number): Promise<void> {
    const list = this.issues.get(agentId) ?? [];
    list.push({ atMs, qty: qtyBaseUnits });
    this.issues.set(agentId, list);
  }

  async issuedInWindow(agentId: string, windowMs: number, nowMs: number): Promise<bigint> {
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
export async function evaluateIntent(
  intent: RvnIntent,
  policy: RvnPolicy,
  ledger: IssueLedger,
  nowMs: number = Date.now(),
): Promise<Decision> {
  const qty = BigInt(intent.qtyBaseUnits);
  const dest = norm(intent.destination);

  // ---- Stage 1: hard denies ----
  if (policy.blockedDestinations.some((d) => norm(d) === dest)) {
    return decide(intent, 'DENY', ['DESTINATION_BLOCKED'], policy, nowMs);
  }

  if (!nameMatchesPattern(intent.kind, intent.assetName, policy.assetNamePattern)) {
    return decide(intent, 'DENY', ['ASSET_NAME_REJECTED'], policy, nowMs);
  }

  if (qty <= 0n) {
    return decide(intent, 'DENY', ['NON_POSITIVE_QTY'], policy, nowMs);
  }

  if (createsSupply(intent.kind)) {
    if (qty > BigInt(policy.maxIssueQtyBaseUnits)) {
      return decide(intent, 'DENY', ['ISSUE_CAP_EXCEEDED'], policy, nowMs);
    }
    const issued24h = await ledger.issuedInWindow(intent.agentId, DAY_MS, nowMs);
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
    createsSupply(intent.kind)
      ? BigInt(policy.approvalAboveIssueQtyBaseUnits)
      : BigInt(policy.approvalAboveTransferQtyBaseUnits);
  if (qty > approvalThreshold) {
    return decide(intent, 'REQUIRE_APPROVAL', ['ABOVE_APPROVAL_THRESHOLD'], policy, nowMs);
  }

  // ---- Stage 3: allow ----
  return decide(intent, 'ALLOW', ['WITHIN_POLICY'], policy, nowMs);
}
