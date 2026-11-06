import type { RvnIntent } from './types.js';

/**
 * Anomaly detection (v0.12.0, slice 1): statistically unusual intents are
 * routed to REQUIRE_APPROVAL with reason code ANOMALY_SUSPECTED, instead of
 * being allowed outright. The detector is pure — it reads a history of the
 * agent's previously submitted intents and returns signals; the policy
 * engine decides what to do with them. It never denies on its own: an
 * anomalous intent still just waits for a human.
 *
 * Signals:
 *   QTY_OUTLIER — the intent's qty is more than 10x the median qty of the
 *     agent's prior intents of the same kind (at least 3 prior samples;
 *     fewer samples means "not enough baseline", not "anomalous"). Median,
 *     not mean, so one past whale issue can't drag the baseline up.
 *   FIRST_SEEN_DESTINATION_BURST — the destination has never appeared in
 *     the agent's history AND the agent submitted at least 3 intents in
 *     the last hour. A new destination on its own is normal (allowlisting
 *     already routes unknown destinations to approval); a new destination
 *     in the middle of a burst is what looks like a compromised agent
 *     spraying funds somewhere new.
 *
 * History entries with unparseable or non-positive qtys are ignored (they
 * carry no baseline information); the current intent itself is excluded
 * by id, so a re-evaluation at approval time can't flag itself.
 *
 * v0.22.0: the four thresholds are policy fields now (AnomalyConfig,
 * resolved by anomalyConfigFromPolicy) — the constants above are the
 * defaults a policy without the fields keeps. detectAnomalies takes an
 * optional config; callers that pass none get the defaults.
 */

export type AnomalySignal = 'QTY_OUTLIER' | 'FIRST_SEEN_DESTINATION_BURST';

/** Minimum same-kind samples before a qty outlier can fire. */
export const ANOMALY_MIN_HISTORY = 3;
/** Qty must exceed this multiple of the same-kind median qty to flag. */
export const ANOMALY_QTY_MULTIPLE = 10n;
/** Window for the first-seen-destination burst signal. */
export const ANOMALY_BURST_WINDOW_MS = 60 * 60 * 1000;
/** Minimum intents in the burst window before a first-seen destination flags. */
export const ANOMALY_BURST_MIN_COUNT = 3;

/**
 * Tunable anomaly thresholds, resolved from a policy (v0.22.0). Every
 * field is optional on the policy; an unset or malformed field falls back
 * to the v0.12.0 constant it replaces, so older policies keep the exact
 * behavior they had — the constants above stay the defaults.
 */
export interface AnomalyConfig {
  /** Qty must exceed this multiple of the same-kind median qty to flag. */
  qtyMultiple: bigint;
  /** Minimum same-kind samples before a qty outlier can fire. */
  minHistory: number;
  /** Window (ms) for the first-seen-destination burst signal. */
  burstWindowMs: number;
  /** Minimum intents in the burst window before a first-seen destination flags. */
  burstMinCount: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  qtyMultiple: ANOMALY_QTY_MULTIPLE,
  minHistory: ANOMALY_MIN_HISTORY,
  burstWindowMs: ANOMALY_BURST_WINDOW_MS,
  burstMinCount: ANOMALY_BURST_MIN_COUNT,
};

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Lenient parse for stored policies: each field falls back to its default
 * when missing or malformed, so a bad stored policy degrades to the
 * v0.12.0 behavior, never a crash. A multiple below 1 would flag every
 * qty above the median, so it is floored to 1.
 */
export function anomalyConfigFromPolicy(
  policy: Pick<
    import('./types.js').RvnPolicy,
    'anomalyQtyMultiple' | 'anomalyMinHistory' | 'anomalyBurstWindowSeconds' | 'anomalyBurstMinCount'
  >,
): AnomalyConfig {
  return {
    qtyMultiple: isPositiveInt(policy.anomalyQtyMultiple)
      ? BigInt(policy.anomalyQtyMultiple)
      : DEFAULT_ANOMALY_CONFIG.qtyMultiple,
    minHistory: isPositiveInt(policy.anomalyMinHistory)
      ? policy.anomalyMinHistory
      : DEFAULT_ANOMALY_CONFIG.minHistory,
    burstWindowMs: isPositiveInt(policy.anomalyBurstWindowSeconds)
      ? policy.anomalyBurstWindowSeconds * 1000
      : DEFAULT_ANOMALY_CONFIG.burstWindowMs,
    burstMinCount: isPositiveInt(policy.anomalyBurstMinCount)
      ? policy.anomalyBurstMinCount
      : DEFAULT_ANOMALY_CONFIG.burstMinCount,
  };
}

/**
 * Strict validation for PUT / preset-override writes: returns an error
 * string, or undefined when valid. Every field must be a positive
 * integer when present (a multiple of 1 is the most sensitive setting —
 * any qty above the median flags — and is allowed).
 */
export function validateAnomalyFields(
  policy: Partial<
    Pick<
      import('./types.js').RvnPolicy,
      'anomalyQtyMultiple' | 'anomalyMinHistory' | 'anomalyBurstWindowSeconds' | 'anomalyBurstMinCount'
    >
  >,
): string | undefined {
  const fields: Array<[string, unknown]> = [
    ['anomalyQtyMultiple', policy.anomalyQtyMultiple],
    ['anomalyMinHistory', policy.anomalyMinHistory],
    ['anomalyBurstWindowSeconds', policy.anomalyBurstWindowSeconds],
    ['anomalyBurstMinCount', policy.anomalyBurstMinCount],
  ];
  for (const [name, value] of fields) {
    if (value !== undefined && !isPositiveInt(value)) {
      return `${name} must be a positive integer when set`;
    }
  }
  return undefined;
}

const norm = (s: string) => s.trim().toLowerCase();

function parseQty(qty: string): bigint | undefined {
  try {
    const n = BigInt(qty);
    return n > 0n ? n : undefined;
  } catch {
    return undefined;
  }
}

export function detectAnomalies(
  intent: RvnIntent,
  history: RvnIntent[],
  nowMs: number = Date.now(),
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): AnomalySignal[] {
  const signals: AnomalySignal[] = [];
  const qty = parseQty(intent.qtyBaseUnits);
  const dest = norm(intent.destination);
  // Prior intents only: exclude the intent itself (approval-time
  // re-evaluation sees it already stored) and anything from the future.
  const prior = history.filter(
    (h) => h.id !== intent.id && h.requestedAtMs <= nowMs,
  );

  // ---- Qty outlier vs the same-kind median ----
  if (qty !== undefined) {
    const sameKind = prior
      .filter((h) => h.kind === intent.kind)
      .map((h) => parseQty(h.qtyBaseUnits))
      .filter((n): n is bigint => n !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (sameKind.length >= config.minHistory) {
      // Lower median for even counts: deterministic, and conservative
      // (a lower baseline flags more readily, which is the safe side
      // for a hold-not-deny signal).
      const median = sameKind[Math.floor((sameKind.length - 1) / 2)];
      if (qty > median * config.qtyMultiple) {
        signals.push('QTY_OUTLIER');
      }
    }
  }

  // ---- First-seen destination inside a burst ----
  const seenBefore = prior.some((h) => norm(h.destination) === dest);
  if (!seenBefore) {
    const recent = prior.filter((h) => h.requestedAtMs >= nowMs - config.burstWindowMs);
    if (recent.length >= config.burstMinCount) {
      signals.push('FIRST_SEEN_DESTINATION_BURST');
    }
  }

  return signals;
}
