import type { RvnPolicy } from './types.js';

/**
 * Rate limiting (v0.18.0 slice 1, v0.19.0 slice 2): per-agent
 * token-bucket operation limits as a policy dimension.
 *
 * A policy opts in by setting BOTH fields; either one missing (or
 * invalid) means unlimited, so every pre-existing policy keeps working
 * unchanged:
 *
 *   rateLimitMaxOps        — bucket capacity: the burst size, in operations
 *   rateLimitWindowSeconds — the window over which a full bucket refills
 *
 * The bucket refills continuously at maxOps / windowSeconds tokens per
 * second, so a 10-op / 60s bucket allows a burst of 10, then roughly one
 * op every 6s sustained. Tokens are fractional internally; an operation
 * needs a whole token. A fresh bucket starts full.
 *
 * Slice 1 scope: one bucket per agent, shared across all operation kinds
 * (issue / reissue / sub-asset / unique / transfer) — the limit is on how
 * fast an agent submits, not on any single kind. The bucket lives in
 * server memory, so a restart refills it; persisting buckets in the store
 * and per-kind buckets are follow-ups.
 *
 * Slice 2 adds a read-only snapshot (GET /v1/ratelimit/:agentId): the
 * current whole-token balance, refill rate, and time until the next token
 * and until full — computed from the same refill math as wouldAllow, but
 * never spending a token and never advancing the bucket's clock, so
 * reading stats can neither throttle nor un-throttle an agent.
 *
 * The gate lives in the server, not in evaluateIntent: it consumes a
 * token on every real submit (even one the policy engine would deny, so
 * a flood of denied attempts still throttles), never on simulate (which
 * peeks via wouldAllow instead, so a dry run reports the DENY it would
 * get without spending a token), and never on approve/deny (resolving a
 * hold is not a new operation).
 */

export interface RateLimitConfig {
  maxOps: number;
  windowSeconds: number;
}

/** Lenient parse for stored policies: anything malformed degrades to unlimited, never a crash. */
export function rateLimitFromPolicy(policy: RvnPolicy): RateLimitConfig | undefined {
  const { rateLimitMaxOps, rateLimitWindowSeconds } = policy;
  if (
    typeof rateLimitMaxOps !== 'number' ||
    typeof rateLimitWindowSeconds !== 'number' ||
    !Number.isInteger(rateLimitMaxOps) ||
    !Number.isInteger(rateLimitWindowSeconds) ||
    rateLimitMaxOps <= 0 ||
    rateLimitWindowSeconds <= 0
  ) {
    return undefined;
  }
  return { maxOps: rateLimitMaxOps, windowSeconds: rateLimitWindowSeconds };
}

/** Strict validation for PUT / preset-override writes: returns an error string, or undefined when valid. */
export function validateRateLimitFields(
  policy: Partial<Pick<RvnPolicy, 'rateLimitMaxOps' | 'rateLimitWindowSeconds'>>,
): string | undefined {
  const { rateLimitMaxOps, rateLimitWindowSeconds } = policy;
  const maxSet = rateLimitMaxOps !== undefined;
  const windowSet = rateLimitWindowSeconds !== undefined;
  if (maxSet !== windowSet) {
    return 'rateLimitMaxOps and rateLimitWindowSeconds must be set together';
  }
  if (!maxSet) return undefined;
  if (
    typeof rateLimitMaxOps !== 'number' ||
    !Number.isInteger(rateLimitMaxOps) ||
    rateLimitMaxOps <= 0
  ) {
    return 'rateLimitMaxOps must be a positive integer';
  }
  if (
    typeof rateLimitWindowSeconds !== 'number' ||
    !Number.isInteger(rateLimitWindowSeconds) ||
    rateLimitWindowSeconds <= 0
  ) {
    return 'rateLimitWindowSeconds must be a positive integer';
  }
  return undefined;
}

interface BucketState {
  tokens: number;
  updatedMs: number;
}

// Fractional refill accumulates in floating point, so a bucket refilled
// to exactly one token can compute as 0.9999999999. Treat anything within
// this epsilon of a whole token as that token — the error this admits is
// microseconds of refill, not a real extra operation.
const TOKEN_EPSILON = 1e-9;

/** In-memory token buckets keyed by an opaque string (the server keys by agentId). */
export class TokenBucket {
  private buckets = new Map<string, BucketState>();

  private refilled(key: string, config: RateLimitConfig, nowMs: number): BucketState {
    const existing = this.buckets.get(key);
    if (!existing) {
      return { tokens: config.maxOps, updatedMs: nowMs };
    }
    // A backwards clock must never drain the bucket.
    const elapsedMs = Math.max(0, nowMs - existing.updatedMs);
    const refill = (elapsedMs / (config.windowSeconds * 1000)) * config.maxOps;
    return {
      tokens: Math.min(config.maxOps, existing.tokens + refill),
      updatedMs: nowMs,
    };
  }

  /** True when an operation right now would find a whole token — without spending one. */
  wouldAllow(key: string, config: RateLimitConfig, nowMs: number = Date.now()): boolean {
    return this.refilled(key, config, nowMs).tokens >= 1 - TOKEN_EPSILON;
  }

  /** Spend one token when available; returns false (and spends nothing) when the bucket is empty. */
  tryConsume(key: string, config: RateLimitConfig, nowMs: number = Date.now()): boolean {
    const state = this.refilled(key, config, nowMs);
    if (state.tokens < 1 - TOKEN_EPSILON) {
      // Persist the refilled level so a later call does not double-count
      // the same elapsed refill, but do not spend what is not there.
      this.buckets.set(key, state);
      return false;
    }
    this.buckets.set(key, { tokens: Math.max(0, state.tokens - 1), updatedMs: nowMs });
    return true;
  }

  /**
   * Read-only snapshot of a bucket: the current whole-token balance,
   * refill rate, and time until the next token and until full. Pure —
   * it uses the same refill math as wouldAllow but neither spends a
   * token nor stores the refilled level, so reading stats never changes
   * what the next submit sees. A never-touched bucket reports full.
   */
  snapshot(key: string, config: RateLimitConfig, nowMs: number = Date.now()): RateLimitStats {
    const tokens = this.refilled(key, config, nowMs).tokens;
    const rate = config.maxOps / config.windowSeconds;
    const whole = Math.min(config.maxOps, Math.floor(tokens + TOKEN_EPSILON));
    const full = tokens >= config.maxOps - TOKEN_EPSILON;
    // Time until the next whole token: a bucket at exactly N tokens
    // needs one full token's worth of refill, not zero.
    const secondsUntilNextToken = full ? 0 : (whole + 1 - tokens) / rate;
    return {
      maxOps: config.maxOps,
      windowSeconds: config.windowSeconds,
      tokensAvailable: whole,
      refillRatePerSecond: rate,
      secondsUntilNextToken,
      secondsUntilFull: full ? 0 : (config.maxOps - tokens) / rate,
      wouldAllow: tokens >= 1 - TOKEN_EPSILON,
    };
  }
}

/** Read-only rate-limit state for one agent, as served by GET /v1/ratelimit/:agentId. */
export interface RateLimitStats {
  maxOps: number;
  windowSeconds: number;
  /** Whole tokens available right now (fractional refill rounded down). */
  tokensAvailable: number;
  /** Continuous refill rate, in tokens per second. */
  refillRatePerSecond: number;
  /** Seconds until the next whole token refills (0 when the bucket is full). */
  secondsUntilNextToken: number;
  /** Seconds until the bucket is completely full (0 when full). */
  secondsUntilFull: number;
  /** Whether a submit right now would find a whole token. */
  wouldAllow: boolean;
}
