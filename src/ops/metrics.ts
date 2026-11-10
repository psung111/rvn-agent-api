/**
 * Ops metrics (v0.26.0): the payload behind GET /v1/metrics — decision
 * counts by kind and reason code, rate-limit 429s by agent and kind,
 * webhook delivery successes/failures by endpoint, approval hold age
 * (oldest pending), and the store backend — so an operator can monitor
 * the API without scraping the audit log.
 *
 * The metrics are derived from the retained audit chain at request time
 * (pure `computeMetrics`, no I/O), so they survive a restart and describe
 * exactly what the durable record says. Two consequences worth knowing:
 *
 *   - Archived slices are NOT counted: once POST /v1/audit/archive
 *     prunes entries from the live chain, those decisions/deliveries leave
 *     the counts (they live in the archive files). Metrics describe the
 *     retained chain, whose length is reported as `audit.entries`.
 *   - DECISION entries whose detail.kind is not a decision kind — the
 *     POLICY_REPLACED entries written by PUT /v1/policies/:agentId and
 *     preset applies — are excluded from the decision counts; they are
 *     policy updates, not intent decisions.
 *   - Approval-time re-evaluation DENYs ARE counted (they are DECISION
 *     entries with kind DENY); an approval itself writes no DECISION
 *     entry, so approving a hold does not change the decision counts.
 *   - Webhook entries written before v0.26.0 carry no `endpoint` in their
 *     detail (the per-endpoint audit arrived with this version); those
 *     deliveries are counted under the `unknown` endpoint key.
 *
 * The payload carries no policy internals and no secrets: agent ids,
 * intent kinds, reason codes, webhook endpoint URLs, and counts only.
 */
import type { AuditEntry } from '../audit.js';
import type { Decision, RvnIntent } from '../policy/index.js';

export type DecisionKind = Decision['kind'];

/** The three decision kinds a DECISION audit entry can carry. */
const DECISION_KINDS: DecisionKind[] = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'];

/** Endpoint key for webhook audit entries that predate per-endpoint recording. */
export const UNKNOWN_ENDPOINT = 'unknown';

export interface OpsMetrics {
  generatedAtMs: number;
  /** Process uptime in whole seconds, for "how long has this API been up". */
  uptimeSeconds: number;
  store: 'memory' | 'postgres';
  audit: {
    /** Entries in the retained chain (the slice these counts cover). */
    entries: number;
    chainValid: boolean;
  };
  decisions: {
    total: number;
    byKind: Record<DecisionKind, number>;
    /** Every reason code counts once per DECISION entry that carries it. */
    byReasonCode: Record<string, number>;
  };
  rateLimit429s: {
    total: number;
    byAgent: Record<string, number>;
    /** By intent kind (issue_asset, transfer_asset, ...). */
    byKind: Record<string, number>;
  };
  webhooks: {
    /** Per endpoint URL: deliveries that landed vs gave up after retries. */
    byEndpoint: Record<string, { delivered: number; failed: number }>;
  };
  approvals: {
    pending: number;
    /** Age of the oldest pending hold in ms, or null when none is pending. */
    oldestPendingAgeMs: number | null;
    oldestPendingIntentId: string | null;
    oldestPendingAgentId: string | null;
  };
}

export interface ComputeMetricsOptions {
  storeKind: 'memory' | 'postgres';
  chainValid: boolean;
  uptimeSeconds: number;
}

/**
 * Aggregate one metrics snapshot from the retained audit entries (ascending
 * by seq) and the current pending holds. Pure: reads nothing, writes
 * nothing, never throws on malformed detail (a non-string kind, a
 * non-array reasonCodes, a missing op/endpoint all degrade to "skip" or
 * "unknown" for that field, never a crash).
 */
export function computeMetrics(
  entries: AuditEntry[],
  pending: Array<{ intent: RvnIntent; decision: Decision }>,
  nowMs: number,
  options: ComputeMetricsOptions,
): OpsMetrics {
  const byKind: Record<DecisionKind, number> = {
    ALLOW: 0,
    REQUIRE_APPROVAL: 0,
    DENY: 0,
  };
  const byReasonCode: Record<string, number> = {};
  const rateLimitByAgent: Record<string, number> = {};
  const rateLimitByKind: Record<string, number> = {};
  const webhooksByEndpoint: Record<string, { delivered: number; failed: number }> = {};
  let decisionsTotal = 0;
  let rateLimitTotal = 0;

  for (const entry of entries) {
    if (entry.kind === 'DECISION') {
      const kind = entry.detail.kind;
      if (typeof kind !== 'string' || !(DECISION_KINDS as string[]).includes(kind)) continue;
      decisionsTotal++;
      byKind[kind as DecisionKind]++;
      const reasonCodes = Array.isArray(entry.detail.reasonCodes) ? entry.detail.reasonCodes : [];
      for (const code of reasonCodes) {
        if (typeof code !== 'string') continue;
        byReasonCode[code] = (byReasonCode[code] ?? 0) + 1;
      }
      if (reasonCodes.includes('RATE_LIMIT_EXCEEDED')) {
        rateLimitTotal++;
        rateLimitByAgent[entry.agentId] = (rateLimitByAgent[entry.agentId] ?? 0) + 1;
        const op = typeof entry.detail.op === 'string' ? entry.detail.op : 'unknown';
        rateLimitByKind[op] = (rateLimitByKind[op] ?? 0) + 1;
      }
      continue;
    }
    if (entry.kind === 'WEBHOOK_DELIVERY' || entry.kind === 'WEBHOOK_DELIVERY_FAILED') {
      const endpoint =
        typeof entry.detail.endpoint === 'string' ? entry.detail.endpoint : UNKNOWN_ENDPOINT;
      const bucket = (webhooksByEndpoint[endpoint] ??= { delivered: 0, failed: 0 });
      if (entry.kind === 'WEBHOOK_DELIVERY') bucket.delivered++;
      else bucket.failed++;
    }
  }

  let oldest: { intent: RvnIntent; decision: Decision } | undefined;
  for (const p of pending) {
    if (!oldest || p.intent.requestedAtMs < oldest.intent.requestedAtMs) oldest = p;
  }

  return {
    generatedAtMs: nowMs,
    uptimeSeconds: Math.max(0, Math.floor(options.uptimeSeconds)),
    store: options.storeKind,
    audit: { entries: entries.length, chainValid: options.chainValid },
    decisions: { total: decisionsTotal, byKind, byReasonCode },
    rateLimit429s: { total: rateLimitTotal, byAgent: rateLimitByAgent, byKind: rateLimitByKind },
    webhooks: { byEndpoint: webhooksByEndpoint },
    approvals: {
      pending: pending.length,
      oldestPendingAgeMs: oldest ? Math.max(0, nowMs - oldest.intent.requestedAtMs) : null,
      oldestPendingIntentId: oldest ? oldest.intent.id : null,
      oldestPendingAgentId: oldest ? oldest.intent.agentId : null,
    },
  };
}
