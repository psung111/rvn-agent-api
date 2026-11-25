import { AuditLog } from '../audit.js';
import type { ApiKeyRecord } from '../auth/keys.js';
import { defaultPolicy, InMemoryIssueLedger, pruneVersions } from '../policy/index.js';
import type { PolicyVersion } from '../policy/history.js';
import type { AuditEntry, AuditKind } from '../audit.js';
import type { Decision, RvnIntent, RvnPolicy } from '../policy/index.js';
import type { ApiKeyStore, AuditStore, IntentStore, PolicyStore, RateLimitBucketState, RateLimitStore, Store, WalletStore } from './types.js';

class MemoryPolicyStore implements PolicyStore {
  private policies = new Map<string, RvnPolicy>([['*', defaultPolicy()]]);
  /** Superseded versions per agent, newest first. */
  private versions = new Map<string, PolicyVersion[]>();
  async get(agentId: string): Promise<RvnPolicy | undefined> {
    return this.policies.get(agentId);
  }
  async set(policy: RvnPolicy): Promise<void> {
    this.policies.set(policy.agentId, policy);
  }
  async history(agentId: string, limit = 100): Promise<PolicyVersion[]> {
    const n = Math.min(Math.max(limit, 1), 1000);
    return (this.versions.get(agentId) ?? [])
      .slice(0, n)
      .map((v) => ({ ...v, policy: { ...v.policy } }));
  }
  async getVersion(agentId: string, versionId: string): Promise<PolicyVersion | undefined> {
    const v = (this.versions.get(agentId) ?? []).find((x) => x.versionId === versionId);
    return v ? { ...v, policy: { ...v.policy } } : undefined;
  }
  async recordVersion(version: PolicyVersion, limit: number): Promise<void> {
    const list = this.versions.get(version.agentId) ?? [];
    // Newest first; pruneVersions keeps the newest `limit`.
    list.unshift({ ...version, policy: { ...version.policy } });
    this.versions.set(version.agentId, pruneVersions(list, limit));
  }
}

class MemoryIntentStore implements IntentStore {
  private intents = new Map<string, RvnIntent>();
  private decisions = new Map<string, Decision>();

  async putIntent(intent: RvnIntent): Promise<void> {
    this.intents.set(intent.id, intent);
  }
  async getIntent(id: string): Promise<RvnIntent | undefined> {
    return this.intents.get(id);
  }
  async putDecision(intentId: string, decision: Decision): Promise<void> {
    this.decisions.set(intentId, decision);
  }
  async getDecision(intentId: string): Promise<Decision | undefined> {
    return this.decisions.get(intentId);
  }
  async pending(nowMs: number = Date.now()): Promise<Array<{ intent: RvnIntent; decision: Decision }>> {
    const out: Array<{ intent: RvnIntent; decision: Decision }> = [];
    for (const [id, intent] of this.intents) {
      const d = this.decisions.get(id);
      if (d && d.kind === 'REQUIRE_APPROVAL' && nowMs <= d.expiresAtMs) {
        out.push({ intent, decision: d });
      }
    }
    return out;
  }
  async history(agentId: string, limit = 200): Promise<RvnIntent[]> {
    const n = Math.min(Math.max(limit, 1), 1000);
    return [...this.intents.values()]
      .filter((intent) => intent.agentId === agentId)
      .sort((a, b) => b.requestedAtMs - a.requestedAtMs)
      .slice(0, n);
  }
}

class MemoryAuditStore implements AuditStore {
  private log = new AuditLog();
  async append(kind: AuditKind, intentId: string, agentId: string, detail: Record<string, unknown> = {}): Promise<AuditEntry> {
    return this.log.append(kind, intentId, agentId, detail);
  }
  async tail(limit = 50): Promise<AuditEntry[]> {
    return this.log.tail(limit);
  }
  async all(): Promise<AuditEntry[]> {
    return this.log.all();
  }
  async verify(): Promise<number> {
    return this.log.verify();
  }
  async oldest(): Promise<AuditEntry | undefined> {
    return this.log.oldest();
  }
  async beforeMs(cutoffMs: number, limit?: number): Promise<AuditEntry[]> {
    return this.log.beforeMs(cutoffMs, limit);
  }
  async prune(beforeSeq: number): Promise<number> {
    return this.log.prune(beforeSeq);
  }
}

class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, RateLimitBucketState>();
  async get(key: string): Promise<RateLimitBucketState | undefined> {
    const state = this.buckets.get(key);
    return state ? { ...state } : undefined;
  }
  async set(key: string, state: RateLimitBucketState): Promise<void> {
    this.buckets.set(key, { ...state });
  }
  async all(): Promise<Array<{ key: string; state: RateLimitBucketState }>> {
    return [...this.buckets.entries()].map(([key, state]) => ({ key, state: { ...state } }));
  }
}

class MemoryApiKeyStore implements ApiKeyStore {
  private keys = new Map<string, ApiKeyRecord>();
  async issue(record: ApiKeyRecord): Promise<void> {
    this.keys.set(record.id, { ...record });
  }
  async getByHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    for (const record of this.keys.values()) {
      if (record.keyHash === keyHash) return { ...record };
    }
    return undefined;
  }
  async getById(id: string): Promise<ApiKeyRecord | undefined> {
    const record = this.keys.get(id);
    return record ? { ...record } : undefined;
  }
  async list(agentId?: string): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((r) => agentId === undefined || r.agentId === agentId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((r) => ({ ...r }));
  }
  async revoke(id: string, revokedAtMs: number): Promise<boolean> {
    const record = this.keys.get(id);
    if (!record) return false;
    if (record.revokedAtMs === undefined) {
      this.keys.set(id, { ...record, revokedAtMs });
    }
    return true;
  }
}

class MemoryWalletStore implements WalletStore {
  private addresses = new Map<string, string>();
  async get(agentId: string): Promise<string | undefined> {
    return this.addresses.get(agentId);
  }
  async set(agentId: string, address: string): Promise<void> {
    this.addresses.set(agentId, address);
  }
}

/** Ephemeral backend: everything lives in process memory. */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  /** No schema to migrate: the memory store never applies migrations. */
  readonly appliedMigrations: readonly string[] = [];
  readonly policies = new MemoryPolicyStore();
  readonly intents = new MemoryIntentStore();
  readonly ledger = new InMemoryIssueLedger();
  readonly audit = new MemoryAuditStore();
  readonly ratelimits = new MemoryRateLimitStore();
  readonly apikeys = new MemoryApiKeyStore();
  readonly wallets = new MemoryWalletStore();
  async close(): Promise<void> {
    // Nothing to release.
  }
}
