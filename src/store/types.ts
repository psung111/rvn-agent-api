import type { AuditEntry, AuditKind } from '../audit.js';
import type { Decision, IssueLedger, RvnIntent, RvnPolicy } from '../policy/index.js';

/** Policy documents keyed by agent id ('*' is the default). */
export interface PolicyStore {
  get(agentId: string): Promise<RvnPolicy | undefined>;
  set(policy: RvnPolicy): Promise<void>;
}

/** Submitted intents and their latest decisions, keyed by intent id. */
export interface IntentStore {
  putIntent(intent: RvnIntent): Promise<void>;
  getIntent(id: string): Promise<RvnIntent | undefined>;
  putDecision(intentId: string, decision: Decision): Promise<void>;
  getDecision(intentId: string): Promise<Decision | undefined>;
  /** Held intents whose approval window has not expired yet. */
  pending(nowMs?: number): Promise<Array<{ intent: RvnIntent; decision: Decision }>>;
  /**
   * Most recent intents for one agent, newest first, for the anomaly
   * detector's baseline. The caller asks before storing the intent under
   * evaluation, so the current intent is not in the result.
   */
  history(agentId: string, limit?: number): Promise<RvnIntent[]>;
}

/** Hash-chained audit log. Implementations must preserve chain order. */
export interface AuditStore {
  append(
    kind: AuditKind,
    intentId: string,
    agentId: string,
    detail?: Record<string, unknown>,
  ): Promise<AuditEntry>;
  /** Newest first. */
  tail(limit?: number): Promise<AuditEntry[]>;
  /** Every retained entry, ascending by seq (for ops metrics aggregation). */
  all(): Promise<AuditEntry[]>;
  /** First broken seq, or -1 when the chain is intact. */
  verify(): Promise<number>;
  /** Oldest retained entry, or undefined when the chain is empty. */
  oldest(): Promise<AuditEntry | undefined>;
  /** Entries older than cutoffMs, ascending by seq, capped at limit (default 10_000). */
  beforeMs(cutoffMs: number, limit?: number): Promise<AuditEntry[]>;
  /**
   * Delete entries with seq < beforeSeq, always keeping the newest entry
   * as the chain anchor for future appends. Returns the deleted count.
   * The caller must have archived the deleted slice first (see
   * src/audit/archive.ts) — prune on its own loses history.
   */
  prune(beforeSeq: number): Promise<number>;
}

/**
 * Durable rate-limit bucket state, keyed by agent id (the server keys its
 * token buckets by agent). `tokens` is fractional; `updatedMs` is the
 * instant the balance was last computed, so refill across a restart is
 * the elapsed time since that timestamp. Mirrors the TokenBucket's
 * BucketState (src/policy/ratelimit.ts) without importing policy code
 * into the store seam.
 */
export interface RateLimitBucketState {
  tokens: number;
  updatedMs: number;
}

/** Persisted token buckets for the rate-limit gate. */
export interface RateLimitStore {
  get(key: string): Promise<RateLimitBucketState | undefined>;
  set(key: string, state: RateLimitBucketState): Promise<void>;
  /** Every stored bucket, for restore at boot. */
  all(): Promise<Array<{ key: string; state: RateLimitBucketState }>>;
}

/**
 * All durable state behind one seam. The server only talks to this interface;
 * `kind` tells operators which backend is actually serving (also on /v1/health).
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  /**
   * Schema migrations applied to this store, oldest first. The in-memory
   * store reports [] (nothing to migrate); the Postgres store reports the
   * versions from schema_migrations (also on /v1/health).
   */
  readonly appliedMigrations: readonly string[];
  readonly policies: PolicyStore;
  readonly intents: IntentStore;
  readonly ledger: IssueLedger;
  readonly audit: AuditStore;
  readonly ratelimits: RateLimitStore;
  close(): Promise<void>;
}
