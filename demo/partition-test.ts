/**
 * partition-test: checks for monthly partitioning of audit_entries (v0.25.0,
 * migration 0003_audit_entries_partitioning + the append-time partition
 * creation in PostgresAuditStore.append).
 *
 *  pnpm test:partition
 *
 * Runs in four parts:
 *   1. Pure checks: auditPartitionFor month bounds (UTC months, exact
 *      month start, last millisecond of a month, Dec->Jan rollover, leap
 *      February) and auditPartitionDdl statement text — no database needed.
 *   2. Shipped migration 0003: loads with 0001/0002, carries the rebuild
 *      pieces, and applies through the fake-pool runner alongside them.
 *   3. Live leg, when TEST_DATABASE_URL (or RVN_DATABASE_URL) is set:
 *      a scratch database is built on the OLD schema (0001+0002 only),
 *      seeded with audit rows from past months, then PostgresStore.connect
 *      runs 0003 — the rebuild must preserve every row in its own month's
 *      partition, the table must report as partitioned, the chain must
 *      still verify, a store append must land in the current month's
 *      partition, and a far-future month must refuse a raw insert until
 *      the partition DDL runs (proving the server-side creation path is
 *      what keeps appends working across month boundaries). Skipped
 *      otherwise, since dev machines may not run Postgres.
 *   4. Health check: boots the real API (memory store) and asserts
 *      /v1/health reports audit.partitioned false.
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { makeChainedEntry } from '../src/audit.js';
import { applyMigrations, loadMigrations } from '../src/store/migrations.js';
import { PostgresStore } from '../src/store/index.js';
import { auditPartitionDdl, auditPartitionFor } from '../src/store/partitions.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

/** Minimal pg stand-in: tracks schema_migrations rows and committed statements. */
class FakeClient {
  private inTxn = false;
  private pendingStatements: string[] = [];
  private pendingInserts: Array<{ version: string; name: string }> = [];
  constructor(private pool: FakePool) {}
  async query(sql: string, params?: unknown[]) {
    const s = sql.trim().toUpperCase();
    if (s === 'BEGIN') {
      this.pool.begins++;
      this.inTxn = true;
      this.pendingStatements = [];
      this.pendingInserts = [];
      return { rows: [] };
    }
    if (s === 'COMMIT') {
      if (!this.inTxn) throw new Error('COMMIT without BEGIN');
      this.pool.committed.push(...this.pendingStatements);
      for (const ins of this.pendingInserts) this.pool.applied.set(ins.version, ins.name);
      this.inTxn = false;
      this.pendingStatements = [];
      this.pendingInserts = [];
      return { rows: [] };
    }
    if (s === 'ROLLBACK') {
      this.inTxn = false;
      this.pendingStatements = [];
      this.pendingInserts = [];
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO SCHEMA_MIGRATIONS')) {
      this.pendingInserts.push({ version: String(params?.[0]), name: String(params?.[1]) });
      return { rows: [] };
    }
    if (this.inTxn) this.pendingStatements.push(sql);
    else this.pool.committed.push(sql);
    return { rows: [] };
  }
  release() {}
}

class FakePool {
  applied = new Map<string, string>();
  committed: string[] = [];
  begins = 0;
  async query(sql: string) {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('CREATE TABLE IF NOT EXISTS SCHEMA_MIGRATIONS')) return { rows: [] };
    if (s.startsWith('SELECT VERSION FROM SCHEMA_MIGRATIONS')) {
      const rows = [...this.applied.keys()]
        .sort()
        .map((version) => ({ version }) as Record<string, unknown>);
      return { rows };
    }
    throw new Error(`unexpected pool-level query: ${sql.slice(0, 80)}`);
  }
  async connect() {
    return new FakeClient(this);
  }
}

async function main() {
  // --- 1. Pure checks: month bounds + DDL text ---
  const nov = auditPartitionFor(Date.UTC(2026, 10, 9, 12, 0, 0));
  check('partition for a mid-month instant', nov.name === 'audit_entries_2026_11' &&
    nov.fromMs === Date.UTC(2026, 10, 1) && nov.toMs === Date.UTC(2026, 11, 1), nov);
  const janStart = auditPartitionFor(Date.UTC(2026, 0, 1));
  check('exact month start stays in its month', janStart.name === 'audit_entries_2026_01' &&
    janStart.fromMs === Date.UTC(2026, 0, 1), janStart);
  const febEnd = auditPartitionFor(Date.UTC(2026, 1, 28, 23, 59, 59, 999));
  check('last ms of Feb (non-leap) stays in Feb', febEnd.name === 'audit_entries_2026_02' &&
    febEnd.toMs === Date.UTC(2026, 2, 1), febEnd);
  const leap = auditPartitionFor(Date.UTC(2028, 1, 29, 12, 0, 0));
  check('leap-day Feb 2028 maps to Feb', leap.name === 'audit_entries_2028_02' &&
    leap.fromMs === Date.UTC(2028, 1, 1) && leap.toMs === Date.UTC(2028, 2, 1), leap);
  const dec = auditPartitionFor(Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  check('Dec rolls over to Jan of the next year', dec.name === 'audit_entries_2026_12' &&
    dec.toMs === Date.UTC(2027, 0, 1), dec);
  const epoch = auditPartitionFor(0);
  check('epoch maps to 1970-01', epoch.name === 'audit_entries_1970_01' &&
    epoch.fromMs === 0 && epoch.toMs === Date.UTC(1970, 1, 1), epoch);
  check('DDL text is exact', auditPartitionDdl(nov) ===
    'CREATE TABLE IF NOT EXISTS audit_entries_2026_11 PARTITION OF audit_entries ' +
    `FOR VALUES FROM (${Date.UTC(2026, 10, 1)}) TO (${Date.UTC(2026, 11, 1)})`,
    auditPartitionDdl(nov));
  check('DDL name carries only the year/month digits', /^audit_entries_\d{4}_\d{2}$/.test(nov.name));

  // --- 2. Shipped migration 0003 ---
  const shipped = loadMigrations(join(repo, 'src', 'store', 'migrations'));
  check('shipped migrations load: 0001 + 0002 + 0003',
    shipped.length === 3 && shipped[2].version === '0003' &&
    shipped[2].name === 'audit_entries_partitioning', shipped.map((m) => m.version));
  const m3 = shipped[2].sql;
  check('0003 builds a range-partitioned rebuild table',
    m3.includes('PARTITION BY RANGE (at_ms)') && m3.includes('CREATE TABLE audit_entries_new') &&
    m3.includes('PRIMARY KEY (seq, at_ms)'), m3.slice(0, 200));
  check('0003 backfills one partition per month, copies, swaps, re-indexes',
    m3.includes('PARTITION OF audit_entries_new') && m3.includes('INSERT INTO audit_entries_new') &&
    m3.includes('DROP TABLE audit_entries') && m3.includes('ALTER TABLE audit_entries_new RENAME TO audit_entries') &&
    m3.includes('CREATE INDEX IF NOT EXISTS audit_entries_intent_id ON audit_entries (intent_id)'));
  check('0003 caps the backfill loop', m3.includes('guard < 120'));

  const pool = new FakePool();
  const applied = await applyMigrations(pool, shipped);
  check('fake-pool fresh apply returns all three versions',
    JSON.stringify(applied) === '["0001","0002","0003"]', applied);
  check('one transaction per migration', pool.begins === 3, pool.begins);
  check('0003 body committed through the runner',
    pool.committed.some((s) => s.includes('PARTITION BY RANGE (at_ms)')), pool.committed.length);

  // --- 3. Live leg against a scratch database (skipped without Postgres) ---
  const pgUrl = process.env.TEST_DATABASE_URL ?? process.env.RVN_DATABASE_URL;
  if (pgUrl) {
    const scratch = `rvn_partition_test_${process.pid}`;
    const adminUrl = new URL(pgUrl);
    adminUrl.pathname = '/postgres';
    const scratchUrl = new URL(pgUrl);
    scratchUrl.pathname = `/${scratch}`;
    let admin: Pool | undefined;
    let store: PostgresStore | undefined;
    let probe: Pool | undefined;
    try {
      admin = new Pool({ connectionString: adminUrl.toString() });
      await admin.query(`CREATE DATABASE "${scratch}"`);
      // Build the OLD schema (0001+0002 only) and seed audit rows from
      // past months, with a real hash chain.
      const adminPool = new Pool({ connectionString: scratchUrl.toString() });
      await applyMigrations(adminPool, shipped.slice(0, 2));
      const seedAt = [
        Date.UTC(2025, 8, 16, 10, 0, 0), // Sep 2025
        Date.UTC(2025, 9, 2, 10, 0, 0), // Oct 2025
        Date.UTC(2025, 10, 4, 10, 0, 0), // Nov 2025
      ];
      let prev = undefined;
      for (let i = 0; i < seedAt.length; i++) {
        const entry = makeChainedEntry(prev, 'DECISION', `seed-intent-${i}`, 'agent-1', {}, seedAt[i]);
        await adminPool.query(
          `INSERT INTO audit_entries (seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [entry.seq, entry.prevHash, entry.hash, entry.atMs, entry.kind, entry.intentId, entry.agentId,
            JSON.stringify(entry.detail)],
        );
        prev = entry;
      }
      await adminPool.end();

      // Connecting runs 0003: the rebuild.
      store = await PostgresStore.connect(scratchUrl.toString());
      check('live connect applies 0003 on top of the old schema',
        JSON.stringify(store.appliedMigrations) === '["0001","0002","0003"]', store.appliedMigrations);
      probe = new Pool({ connectionString: scratchUrl.toString() });
      const { rows: kindRows } = await probe.query(
        "SELECT relkind FROM pg_class WHERE relname = 'audit_entries'",
      );
      check('audit_entries is a partitioned table live', kindRows[0]?.relkind === 'p', kindRows);
      const { rows: partRows } = await probe.query(
        `SELECT inhrelid::regclass::text AS name FROM pg_inherits
         WHERE inhparent = 'audit_entries'::regclass ORDER BY 1`,
      );
      const names = partRows.map((r) => r.name as string);
      const now = new Date();
      const cur = auditPartitionFor(Date.now()).name;
      const next1 = auditPartitionFor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).name;
      const next2 = auditPartitionFor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).name;
      check('rebuild kept one partition per seeded month + current + next two',
        ['audit_entries_2025_09', 'audit_entries_2025_10', 'audit_entries_2025_11', cur, next1, next2]
          .every((n) => names.includes(n)), names);
      const { rows: cnt } = await probe.query('SELECT count(*)::int AS n FROM audit_entries');
      check('all seeded rows survived the rebuild', cnt[0]?.n === 3, cnt);
      for (const [part, want] of [['audit_entries_2025_09', 1], ['audit_entries_2025_10', 1], ['audit_entries_2025_11', 1]] as const) {
        const { rows: c } = await probe.query(`SELECT count(*)::int AS n FROM ${part}`);
        check(`seeded row landed in ${part}`, c[0]?.n === want, c);
      }
      check('chain still verifies after the rebuild', (await store.audit.verify()) === -1);
      // A store append lands in the current month's partition.
      await store.audit.append('DECISION', 'live-intent', 'agent-1', {});
      const { rows: curCnt } = await probe.query(`SELECT count(*)::int AS n FROM ${cur}`);
      check('store append lands in the current month partition', curCnt[0]?.n === 1, curCnt);
      check('chain still verifies after the append', (await store.audit.verify()) === -1);
      // A far-future month refuses a raw insert until its partition exists.
      const futureAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, 15);
      const futurePart = auditPartitionFor(futureAt);
      const tail = await store.audit.tail(1);
      const futureEntry = makeChainedEntry(tail[0], 'DECISION', 'future-intent', 'agent-1', {}, futureAt);
      const insertFuture = () => probe!.query(
        `INSERT INTO audit_entries (seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [futureEntry.seq, futureEntry.prevHash, futureEntry.hash, futureEntry.atMs, futureEntry.kind,
          futureEntry.intentId, futureEntry.agentId, JSON.stringify(futureEntry.detail)],
      );
      let rawErr: unknown;
      try {
        await insertFuture();
      } catch (err) {
        rawErr = err;
      }
      check('raw insert into a month with no partition fails',
        rawErr instanceof Error && /no partition of relation/.test(rawErr.message),
        (rawErr as Error)?.message);
      await probe.query(auditPartitionDdl(futurePart));
      await insertFuture();
      const { rows: futCnt } = await probe.query(`SELECT count(*)::int AS n FROM ${futurePart.name}`);
      check('partition DDL lets the far-future insert through', futCnt[0]?.n === 1, futCnt);
      check('chain verifies across the far-future row', (await store.audit.verify()) === -1);
      // The archive/prune flow still works on the partitioned table.
      const pruned = await store.audit.prune(1);
      check('prune still works on the partitioned table', pruned === 1, pruned);
      check('chain verifies after prune', (await store.audit.verify()) === -1);

      await probe.end();
      probe = undefined;
      const again = await PostgresStore.connect(scratchUrl.toString());
      check('live reconnect is idempotent',
        JSON.stringify(again.appliedMigrations) === '["0001","0002","0003"]', again.appliedMigrations);
      await again.close();
      await store.close();
      store = undefined;
    } catch (err) {
      check('live leg ran', false, (err as Error).message);
    } finally {
      await probe?.end().catch(() => undefined);
      await store?.close().catch(() => undefined);
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
        await admin.end();
      }
    }
  } else {
    console.log('--- live leg: skipped (set TEST_DATABASE_URL to run against a live Postgres) ---');
  }

  // --- 4. /v1/health reports audit.partitioned (memory store: false) ---
  const API_PORT = 3125;
  const API = `http://127.0.0.1:${API_PORT}`;
  const api: ChildProcess = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(API_PORT), MOCK_RVN: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let health: Record<string, unknown> | undefined;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${API}/v1/health`);
        if (r.ok) {
          health = (await r.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    check('health reports audit.partitioned false on the memory store',
      (health?.audit as Record<string, unknown> | undefined)?.partitioned === false, health?.audit);
  } finally {
    api.kill();
  }

  console.log(failures === 0 ? '\npartition-test: all green' : `\npartition-test: FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
