import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { makeChainedEntry, verifyChain, type AuditEntry, type AuditKind } from '../audit.js';
import type { Decision, IssueLedger, RvnIntent, RvnPolicy } from '../policy/index.js';
import { applyMigrations, loadMigrations, type Migration } from './migrations.js';
import type { AuditStore, IntentStore, PolicyStore, RateLimitBucketState, RateLimitStore, Store } from './types.js';

function rowToEntry(r: {
  seq: string | number; prev_hash: string; hash: string; at_ms: string | number;
  kind: string; intent_id: string; agent_id: string; detail: string;
}): AuditEntry {
  return {
    seq: Number(r.seq),
    prevHash: r.prev_hash,
    hash: r.hash,
    atMs: Number(r.at_ms),
    kind: r.kind as AuditEntry['kind'],
    intentId: r.intent_id,
    agentId: r.agent_id,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  };
}

class PostgresPolicyStore implements PolicyStore {
  constructor(private pool: Pool) {}
  async get(agentId: string): Promise<RvnPolicy | undefined> {
    const { rows } = await this.pool.query('SELECT policy FROM policies WHERE agent_id = $1', [agentId]);
    return rows[0]?.policy as RvnPolicy | undefined;
  }
  async set(policy: RvnPolicy): Promise<void> {
    await this.pool.query(
      `INSERT INTO policies (agent_id, policy, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (agent_id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now()`,
      [policy.agentId, JSON.stringify(policy)],
    );
  }
}

class PostgresIntentStore implements IntentStore {
  constructor(private pool: Pool) {}
  async putIntent(intent: RvnIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO intents (id, intent) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET intent = EXCLUDED.intent`,
      [intent.id, JSON.stringify(intent)],
    );
  }
  async getIntent(id: string): Promise<RvnIntent | undefined> {
    const { rows } = await this.pool.query('SELECT intent FROM intents WHERE id = $1', [id]);
    return rows[0]?.intent as RvnIntent | undefined;
  }
  async putDecision(intentId: string, decision: Decision): Promise<void> {
    await this.pool.query(
      `INSERT INTO decisions (intent_id, decision, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (intent_id) DO UPDATE SET decision = EXCLUDED.decision, updated_at = now()`,
      [intentId, JSON.stringify(decision)],
    );
  }
  async getDecision(intentId: string): Promise<Decision | undefined> {
    const { rows } = await this.pool.query('SELECT decision FROM decisions WHERE intent_id = $1', [intentId]);
    return rows[0]?.decision as Decision | undefined;
  }
  async pending(nowMs: number = Date.now()): Promise<Array<{ intent: RvnIntent; decision: Decision }>> {
    const { rows } = await this.pool.query(
      `SELECT i.intent, d.decision FROM intents i
       JOIN decisions d ON d.intent_id = i.id
       WHERE d.decision->>'kind' = 'REQUIRE_APPROVAL'
         AND (d.decision->>'expiresAtMs')::bigint > $1`,
      [nowMs],
    );
    return rows.map((r) => ({ intent: r.intent as RvnIntent, decision: r.decision as Decision }));
  }
  async history(agentId: string, limit = 200): Promise<RvnIntent[]> {
    const n = Math.min(Math.max(limit, 1), 1000);
    const { rows } = await this.pool.query(
      `SELECT intent FROM intents
       WHERE intent->>'agentId' = $1
       ORDER BY (intent->>'requestedAtMs')::bigint DESC
       LIMIT $2`,
      [agentId, n],
    );
    return rows.map((r) => r.intent as RvnIntent);
  }
}

class PostgresAuditStore implements AuditStore {
  constructor(private pool: Pool) {}
  async append(
    kind: AuditKind,
    intentId: string,
    agentId: string,
    detail: Record<string, unknown> = {},
  ): Promise<AuditEntry> {
    // Serialize appends with an advisory lock so the chain can never fork:
    // prev/seq are read and the row inserted in one locked transaction.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('rvn_agent_api_audit_append'))`);
      const { rows } = await client.query(
        'SELECT seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail FROM audit_entries ORDER BY seq DESC LIMIT 1',
      );
      const prev = rows[0] ? rowToEntry(rows[0]) : undefined;
      const entry = makeChainedEntry(prev, kind, intentId, agentId, detail);
      await client.query(
        `INSERT INTO audit_entries (seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [entry.seq, entry.prevHash, entry.hash, entry.atMs, entry.kind, entry.intentId, entry.agentId, JSON.stringify(entry.detail)],
      );
      await client.query('COMMIT');
      return entry;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  async tail(limit = 50): Promise<AuditEntry[]> {
    const n = Math.min(Math.max(limit, 1), 500);
    const { rows } = await this.pool.query(
      'SELECT seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail FROM audit_entries ORDER BY seq DESC LIMIT $1',
      [n],
    );
    return rows.map(rowToEntry);
  }
  async verify(): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail FROM audit_entries ORDER BY seq ASC',
    );
    if (rows.length === 0) return -1;
    // Anchor at the oldest retained entry's prevHash: after a retention
    // prune that is the archived head hash, not 'GENESIS' (see
    // verifyChain in src/audit.ts); unpruned chains anchor at 'GENESIS'.
    return verifyChain(rows.map(rowToEntry), rows[0].prev_hash as string);
  }
  async oldest(): Promise<AuditEntry | undefined> {
    const { rows } = await this.pool.query(
      'SELECT seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail FROM audit_entries ORDER BY seq ASC LIMIT 1',
    );
    return rows[0] ? rowToEntry(rows[0]) : undefined;
  }
  async beforeMs(cutoffMs: number, limit = 10_000): Promise<AuditEntry[]> {
    const n = Math.min(Math.max(limit, 1), 50_000);
    const { rows } = await this.pool.query(
      'SELECT seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail FROM audit_entries WHERE at_ms < $1 ORDER BY seq ASC LIMIT $2',
      [cutoffMs, n],
    );
    return rows.map(rowToEntry);
  }
  async prune(beforeSeq: number): Promise<number> {
    // Always keep the newest row as the chain anchor for future appends,
    // even when the caller asks to prune past it.
    const { rowCount } = await this.pool.query(
      `DELETE FROM audit_entries
        WHERE seq < $1 AND seq < (SELECT MAX(seq) FROM audit_entries)`,
      [beforeSeq],
    );
    return rowCount ?? 0;
  }
}

class PostgresRateLimitStore implements RateLimitStore {
  constructor(private pool: Pool) {}
  async get(key: string): Promise<RateLimitBucketState | undefined> {
    const { rows } = await this.pool.query(
      'SELECT tokens, updated_ms FROM ratelimit_buckets WHERE key = $1',
      [key],
    );
    if (!rows[0]) return undefined;
    const tokens = Number(rows[0].tokens);
    const updatedMs = Number(rows[0].updated_ms);
    // A corrupt row (NaN tokens can be stored in a DOUBLE PRECISION
    // column) reads as absent: the bucket restores as full rather than
    // taking the gate down, and the next write overwrites the row.
    if (!Number.isFinite(tokens) || !Number.isFinite(updatedMs) || tokens < 0 || updatedMs < 0) {
      return undefined;
    }
    return { tokens, updatedMs };
  }
  async set(key: string, state: RateLimitBucketState): Promise<void> {
    await this.pool.query(
      `INSERT INTO ratelimit_buckets (key, tokens, updated_ms, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET tokens = EXCLUDED.tokens, updated_ms = EXCLUDED.updated_ms, updated_at = now()`,
      [key, state.tokens, state.updatedMs],
    );
  }
  async all(): Promise<Array<{ key: string; state: RateLimitBucketState }>> {
    const { rows } = await this.pool.query('SELECT key, tokens, updated_ms FROM ratelimit_buckets');
    const out: Array<{ key: string; state: RateLimitBucketState }> = [];
    for (const r of rows) {
      const tokens = Number(r.tokens);
      const updatedMs = Number(r.updated_ms);
      if (Number.isFinite(tokens) && Number.isFinite(updatedMs) && tokens >= 0 && updatedMs >= 0) {
        out.push({ key: r.key as string, state: { tokens, updatedMs } });
      }
    }
    return out;
  }
}

class PostgresLedger implements IssueLedger {
  constructor(private pool: Pool) {}
  async recordIssue(agentId: string, qtyBaseUnits: bigint, atMs: number): Promise<void> {
    await this.pool.query('INSERT INTO ledger_spend (agent_id, at_ms, qty_base_units) VALUES ($1, $2, $3)', [
      agentId,
      atMs,
      qtyBaseUnits.toString(),
    ]);
  }
  async issuedInWindow(agentId: string, windowMs: number, nowMs: number): Promise<bigint> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(qty_base_units::numeric), 0)::text AS total FROM ledger_spend
       WHERE agent_id = $1 AND at_ms >= $2`,
      [agentId, nowMs - windowMs],
    );
    return BigInt(rows[0].total as string);
  }
}

/** Postgres-backed store. Use PostgresStore.connect(); it runs the versioned migrations. */
export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  readonly appliedMigrations: readonly string[];
  readonly policies: PolicyStore;
  readonly intents: IntentStore;
  readonly ledger: IssueLedger;
  readonly audit: AuditStore;
  readonly ratelimits: RateLimitStore;

  private constructor(private pool: Pool, appliedMigrations: readonly string[]) {
    this.appliedMigrations = appliedMigrations;
    this.policies = new PostgresPolicyStore(pool);
    this.intents = new PostgresIntentStore(pool);
    this.ledger = new PostgresLedger(pool);
    this.audit = new PostgresAuditStore(pool);
    this.ratelimits = new PostgresRateLimitStore(pool);
  }

  /**
   * Connects, runs pending versioned migrations from src/store/migrations/
   * (each in its own transaction), and smoke-tests the connection. Throws
   * on any failure; a MigrationError means the schema is in a state the
   * code cannot trust, and it must fail fast (see storeFromEnv) rather
   * than silently falling back to memory and splitting the audit chain.
   */
  static async connect(databaseUrl: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
    try {
      const migrations: Migration[] = loadMigrations(
        fileURLToPath(new URL('./migrations/', import.meta.url)),
      );
      const applied = await applyMigrations(pool, migrations);
      await pool.query('SELECT 1');
      return new PostgresStore(pool, applied);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
