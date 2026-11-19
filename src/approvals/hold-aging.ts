/**
 * Hold-aging alerts (v0.34.0): a hold that sits unapproved is silent today.
 * Once a pending hold is older than `alertAfterMs`, the server re-notifies
 * the approvers — a Telegram reminder plus an `intent.hold_aging` webhook
 * event — exactly once per hold, with the hold's age and n/N quorum
 * progress in the payload. The alert is audited as HOLD_AGING_ALERT.
 *
 * The "once" is a persisted flag on the decision itself
 * (`Decision.holdAlertedAtMs`), so a restart cannot lose the alert state:
 * after a restart the sweep runs again at boot and skips every hold that
 * already alerted. Approving or denying a hold clears it inherently — the
 * decision leaves REQUIRE_APPROVAL, so it is no longer pending and the
 * sweep never sees it again.
 *
 * Config comes from the environment, lenient like the webhook and
 * rate-limit config: invalid values fall back to the defaults, never a
 * startup crash.
 *
 *   RVN_HOLD_ALERT_AFTER_MS   — ms a hold must sit before the alert
 *                               fires (default 3600000 = 1h; 1000..7d).
 *   RVN_HOLD_ALERT_CHECK_MS   — ms between sweeps inside the server
 *                               (default 60000; 1000..1h).
 */
import type { Decision, RvnIntent } from '../policy/types.js';
import type { WebhookEvent } from '../webhooks/dispatcher.js';

export interface HoldAgingConfig {
  /** ms a hold must sit unapproved before the alert fires. */
  alertAfterMs: number;
  /** ms between sweeps inside the server. */
  checkIntervalMs: number;
}

export const DEFAULT_HOLD_AGING: HoldAgingConfig = {
  alertAfterMs: 3600000,
  checkIntervalMs: 60000,
};

const MAX_ALERT_AFTER_MS = 7 * 24 * 3600 * 1000; // 7 days
const MAX_CHECK_INTERVAL_MS = 3600 * 1000; // 1 hour

function parseIntInRange(value: string | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Lenient env parsing: anything malformed falls back to the default. */
export function holdAgingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HoldAgingConfig {
  return {
    alertAfterMs: parseIntInRange(env.RVN_HOLD_ALERT_AFTER_MS, 1000, MAX_ALERT_AFTER_MS, DEFAULT_HOLD_AGING.alertAfterMs),
    checkIntervalMs: parseIntInRange(
      env.RVN_HOLD_ALERT_CHECK_MS,
      1000,
      MAX_CHECK_INTERVAL_MS,
      DEFAULT_HOLD_AGING.checkIntervalMs,
    ),
  };
}

/** Human age for the reminder message: "45s", "5m", "1h 5m", "2d 3h". */
export function formatAgeMs(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const m = totalMinutes % 60;
    return m === 0 ? `${totalHours}h` : `${totalHours}h ${m}m`;
  }
  const days = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h === 0 ? `${days}d` : `${days}d ${h}h`;
}

/** Quorum progress for a held decision, when a quorum is in force. */
export interface QuorumProgress {
  approvalsReceived: number;
  approvalsRequired: number;
  /** Roster size (M) when one was snapshotted onto the hold. */
  approversTotal?: number;
}

export function quorumProgressOf(decision: Decision): QuorumProgress | undefined {
  if (decision.quorumRequired === undefined) return undefined;
  return {
    approvalsReceived: (decision.approvals ?? []).length,
    approvalsRequired: decision.quorumRequired,
    ...(decision.quorumApprovers !== undefined ? { approversTotal: decision.quorumApprovers.length } : {}),
  };
}

/** The hold-aging payload carried on the webhook event and the audit entry. */
export interface HoldAgingInfo {
  ageMs: number;
  quorum?: QuorumProgress;
}

export function holdAgingInfoOf(decision: Decision, ageMs: number): HoldAgingInfo {
  const quorum = quorumProgressOf(decision);
  return { ageMs, ...(quorum ? { quorum } : {}) };
}

/** A hold is due for its (single) aging alert at nowMs. */
export function isHoldAgingDue(decision: Decision, alertAfterMs: number, nowMs: number): boolean {
  if (decision.kind !== 'REQUIRE_APPROVAL') return false;
  if (decision.holdAlertedAtMs !== undefined) return false;
  return nowMs - decision.decidedAtMs >= alertAfterMs;
}

export interface HoldAgingDeps {
  /** Pending holds (REQUIRE_APPROVAL, unexpired) at sweep time. */
  pending: Array<{ intent: RvnIntent; decision: Decision }>;
  /** Re-notify the approvers (Telegram reminder; no-op when unconfigured). */
  notifyAging: (intent: RvnIntent, decision: Decision, ageMs: number) => Promise<void>;
  /** Deliver the webhook event; never throws into the sweep (mirrors the server helper). */
  deliverWebhook: (
    event: WebhookEvent,
    intent: RvnIntent,
    extra: { decision?: Decision; holdAging?: HoldAgingInfo },
  ) => Promise<void>;
  /** Append the HOLD_AGING_ALERT audit entry. */
  audit: (kind: string, intentId: string, agentId: string, detail: Record<string, unknown>) => Promise<unknown>;
  /** Persist the alerted flag on the decision. */
  markAlerted: (intentId: string, decision: Decision) => Promise<void>;
  /** Optional log sink for per-hold failures (the sweep never throws). */
  log?: (message: string) => void;
}

export interface HoldAgingResult {
  /** Pending holds examined. */
  checked: number;
  /** Intent ids that got their (single) aging alert this sweep. */
  alerted: string[];
}

/**
 * One sweep: alert every due hold exactly once. A channel failure never
 * blocks the other channel, the audit, or the flag — but a hold whose
 * flag could not be persisted is NOT counted as alerted, so the next
 * sweep retries it instead of silently dropping the alert. A hold is
 * marked alerted after both channels were attempted, so a crash between
 * the send and the mark can at most re-alert once after a restart —
 * never silently skip.
 */
export async function checkHoldAging(
  config: HoldAgingConfig,
  deps: HoldAgingDeps,
  nowMs: number = Date.now(),
): Promise<HoldAgingResult> {
  const result: HoldAgingResult = { checked: deps.pending.length, alerted: [] };
  for (const { intent, decision } of deps.pending) {
    if (!isHoldAgingDue(decision, config.alertAfterMs, nowMs)) continue;
    const ageMs = nowMs - decision.decidedAtMs;
    const info = holdAgingInfoOf(decision, ageMs);
    let notified = false;
    try {
      await deps.notifyAging(intent, decision, ageMs);
      notified = true;
    } catch (err) {
      deps.log?.(`hold-aging notify failed for ${intent.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await deps.deliverWebhook('intent.hold_aging', intent, { decision, holdAging: info });
    } catch (err) {
      deps.log?.(`hold-aging webhook failed for ${intent.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await deps.markAlerted(intent.id, { ...decision, holdAlertedAtMs: nowMs });
    } catch (err) {
      deps.log?.(`hold-aging mark failed for ${intent.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      await deps.audit('HOLD_AGING_ALERT', intent.id, intent.agentId, {
        ageMs,
        notified,
        ...(info.quorum
          ? {
              approvalsReceived: info.quorum.approvalsReceived,
              approvalsRequired: info.quorum.approvalsRequired,
              ...(info.quorum.approversTotal !== undefined ? { approversTotal: info.quorum.approversTotal } : {}),
            }
          : {}),
      });
    } catch (err) {
      deps.log?.(`hold-aging audit failed for ${intent.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    result.alerted.push(intent.id);
  }
  return result;
}
