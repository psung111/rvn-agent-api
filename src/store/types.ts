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
  /** First broken seq, or -1 when the chain is intact. */
  verify(): Promise<number>;
}

/**
 * All durable state behind one seam. The server only talks to this interface;
 * `kind` tells operators which backend is actually serving (also on /v1/health).
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  readonly policies: PolicyStore;
  readonly intents: IntentStore;
  readonly ledger: IssueLedger;
  readonly audit: AuditStore;
  close(): Promise<void>;
}
