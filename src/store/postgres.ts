import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { makeChainedEntry, verifyChain, type AuditEntry, type AuditKind } from '../audit.js';
import type { Decision, IssueLedger, RvnIntent, RvnPolicy } from '../policy/index.js';
import type { AuditStore, IntentStore, PolicyStore, Store } from './types.js';

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

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
    return verifyChain(rows.map(rowToEntry));
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

/** Postgres-backed store. Use PostgresStore.connect(); it applies the schema. */
export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  readonly policies: PolicyStore;
  readonly intents: IntentStore;
  readonly ledger: IssueLedger;
  readonly audit: AuditStore;

  private constructor(private pool: Pool) {
    this.policies = new PostgresPolicyStore(pool);
    this.intents = new PostgresIntentStore(pool);
    this.ledger = new PostgresLedger(pool);
    this.audit = new PostgresAuditStore(pool);
  }

  /** Connects, applies schema.sql, and smoke-tests the connection. Throws on any failure. */
  static async connect(databaseUrl: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
    try {
      await pool.query(SCHEMA_SQL);
      await pool.query('SELECT 1');
      return new PostgresStore(pool);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
