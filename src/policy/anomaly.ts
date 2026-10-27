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
    if (sameKind.length >= ANOMALY_MIN_HISTORY) {
      // Lower median for even counts: deterministic, and conservative
      // (a lower baseline flags more readily, which is the safe side
      // for a hold-not-deny signal).
      const median = sameKind[Math.floor((sameKind.length - 1) / 2)];
      if (qty > median * ANOMALY_QTY_MULTIPLE) {
        signals.push('QTY_OUTLIER');
      }
    }
  }

  // ---- First-seen destination inside a burst ----
  const seenBefore = prior.some((h) => norm(h.destination) === dest);
  if (!seenBefore) {
    const recent = prior.filter((h) => h.requestedAtMs >= nowMs - ANOMALY_BURST_WINDOW_MS);
    if (recent.length >= ANOMALY_BURST_MIN_COUNT) {
      signals.push('FIRST_SEEN_DESTINATION_BURST');
    }
  }

  return signals;
}
