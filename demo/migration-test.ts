/**
 * migration-test: checks for the versioned Postgres schema migrations
 * (src/store/migrations.ts + src/store/migrations/*.sql).
 *
 *  pnpm test:migrations
 *
 * Runs in three parts:
 *   1. Pure checks: filename parsing, migration-set validation (order,
 *      duplicates, gaps, first-version rule), and loadMigrations against a
 *      temp directory — no database needed.
 *   2. Runner checks against a fake pool: fresh apply in order with one
 *      transaction per migration, idempotent re-run, a failing migration
 *      rolling back (no row, no committed statements) and succeeding on
 *      retry, an unknown applied version (code downgrade) and a gap in the
 *      applied set both failing fast with a clear error.
 *   3. Live leg, when TEST_DATABASE_URL (or RVN_DATABASE_URL) is set:
 *      creates a scratch database, connects via PostgresStore.connect
 *      (which runs the real migrations), verifies the applied versions and
 *      the 0002 index, reconnects to prove idempotence, then drops the
 *      scratch database. Skipped otherwise, since dev machines may not
 *      run Postgres.
 *   4. Health check: boots the real API (memory store) and asserts
 *      /v1/health reports the applied migrations ([] for memory).
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  applyMigrations,
  loadMigrations,
  MigrationError,
  parseMigrationFilename,
  validateMigrationSet,
  type Migration,
  type MigrationClient,
  type MigrationPool,
} from '../src/store/migrations.js';
import { PostgresStore } from '../src/store/index.js';

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

function expectMigrationError(name: string, fn: () => unknown | Promise<unknown>) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => check(name, false, 'expected a MigrationError, got success'),
      (err) => check(name, err instanceof MigrationError, (err as Error)?.message),
    );
}

/** Minimal pg stand-in: tracks schema_migrations rows and committed statements. */
class FakeClient implements MigrationClient {
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
    if (this.pool.failOn?.(sql)) throw new Error(`fake failure on: ${sql.slice(0, 60)}`);
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

class FakePool implements MigrationPool {
  applied = new Map<string, string>();
  committed: string[] = [];
  begins = 0;
  failOn?: (sql: string) => boolean;
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
  async connect(): Promise<MigrationClient> {
    return new FakeClient(this);
  }
}

const M = (version: string, name: string): Migration => ({ version, name, sql: `-- ${name}\nSELECT 1;` });

async function main() {
  // --- 1. Filename parsing ---
  check('parse valid filename', JSON.stringify(parseMigrationFilename('0001_initial.sql')) ===
    JSON.stringify({ version: '0001', name: 'initial' }));
  check('parse hyphenated name', parseMigrationFilename('0002_decisions-kind-index.sql')?.name === 'decisions-kind-index');
  check('reject missing version', parseMigrationFilename('initial.sql') === undefined);
  check('reject missing name', parseMigrationFilename('0001.sql') === undefined);
  check('reject non-sql', parseMigrationFilename('0001_initial.txt') === undefined);

  // --- 2. Migration-set validation ---
  check('valid set passes', (() => { validateMigrationSet([M('0001', 'a'), M('0002', 'b')]); return true; })());
  await expectMigrationError('duplicate version rejected', () =>
    validateMigrationSet([M('0001', 'a'), M('0001', 'b')]));
  await expectMigrationError('gap rejected', () => validateMigrationSet([M('0001', 'a'), M('0003', 'c')]));
  await expectMigrationError('out-of-order rejected', () =>
    validateMigrationSet([M('0002', 'b'), M('0001', 'a')]));
  await expectMigrationError('first version must be 0001', () => validateMigrationSet([M('0002', 'b')]));

  // --- 3. loadMigrations against a temp directory ---
  const dir = mkdtempSync(join(tmpdir(), 'rvn-migrations-'));
  try {
    writeFileSync(join(dir, '0001_initial.sql'), 'CREATE TABLE t1 (id INT);');
    writeFileSync(join(dir, '0002_add_index.sql'), 'CREATE INDEX i1 ON t1 (id);');
    const loaded = loadMigrations(dir);
    check('loadMigrations returns both in order',
      loaded.length === 2 && loaded[0].version === '0001' && loaded[1].version === '0002' &&
      loaded[1].sql.includes('CREATE INDEX'), loaded.map((m) => m.version));
    writeFileSync(join(dir, 'badname.sql'), 'SELECT 1;');
    await expectMigrationError('misnamed file rejected by loadMigrations', () => loadMigrations(dir));
    rmSync(join(dir, 'badname.sql'));
    rmSync(join(dir, '0002_add_index.sql'));
    await expectMigrationError('gap in files rejected by loadMigrations', () => {
      writeFileSync(join(dir, '0003_later.sql'), 'SELECT 1;');
      return loadMigrations(dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The shipped migrations parse and validate.
  const shipped = loadMigrations(join(repo, 'src', 'store', 'migrations'));
  check('shipped migrations load: 0001 + 0002',
    shipped.length === 2 && shipped[0].version === '0001' && shipped[1].version === '0002',
    shipped.map((m) => m.version));
  check('0001 carries the baseline tables',
    shipped[0].sql.includes('CREATE TABLE IF NOT EXISTS audit_entries') &&
    shipped[0].sql.includes('CREATE TABLE IF NOT EXISTS ratelimit_buckets'));
  check('0002 adds the decisions kind index',
    shipped[1].sql.includes('decisions_kind') && shipped[1].sql.includes("decision->>'kind'"));

  // --- 4. Runner against the fake pool ---
  const pool = new FakePool();
  const applied = await applyMigrations(pool, shipped);
  check('fresh apply returns both versions', JSON.stringify(applied) === '["0001","0002"]', applied);
  check('both migrations recorded', pool.applied.get('0001') === 'initial' &&
    pool.applied.get('0002') === 'decisions_kind_index', [...pool.applied.entries()]);
  check('one transaction per migration', pool.begins === 2, pool.begins);
  check('both migration bodies committed',
    pool.committed.some((s) => s.includes('audit_entries')) &&
    pool.committed.some((s) => s.includes('decisions_kind')), pool.committed.length);

  const beginsBefore = pool.begins;
  const committedBefore = pool.committed.length;
  const reapplied = await applyMigrations(pool, shipped);
  check('re-run is a no-op', JSON.stringify(reapplied) === '["0001","0002"]' &&
    pool.begins === beginsBefore && pool.committed.length === committedBefore);

  // Failing migration: rolls back, leaves no row, retry succeeds.
  const flaky = new FakePool();
  flaky.failOn = (sql) => sql.includes('decisions_kind');
  await applyMigrations(flaky, [shipped[0]]);
  check('0001 applied before the failing 0002', flaky.applied.has('0001') && !flaky.applied.has('0002'));
  let failErr: unknown;
  try {
    await applyMigrations(flaky, shipped);
  } catch (err) {
    failErr = err;
  }
  check('failing migration throws MigrationError naming 0002',
    failErr instanceof MigrationError && (failErr as Error).message.includes('0002'),
    (failErr as Error)?.message);
  check('failed migration left no row and no committed statements',
    !flaky.applied.has('0002') && !flaky.committed.some((s) => s.includes('decisions_kind')));
  check('0001 row survived the failed 0002', flaky.applied.get('0001') === 'initial');
  flaky.failOn = undefined;
  const afterRetry = await applyMigrations(flaky, shipped);
  check('retry after failure applies the pending migration',
    JSON.stringify(afterRetry) === '["0001","0002"]' && flaky.applied.get('0002') === 'decisions_kind_index');

  // Inconsistent database states fail fast.
  const downgraded = new FakePool();
  downgraded.applied.set('9999', 'future');
  await expectMigrationError('unknown applied version (downgrade) rejected', () =>
    applyMigrations(downgraded, shipped));
  const gapped = new FakePool();
  const three = [...shipped, M('0003', 'later')];
  gapped.applied.set('0001', 'initial');
  gapped.applied.set('0003', 'later');
  await expectMigrationError('gap in applied set rejected', () => applyMigrations(gapped, three));

  // --- 5. Live leg against a scratch database (skipped without Postgres) ---
  const pgUrl = process.env.TEST_DATABASE_URL ?? process.env.RVN_DATABASE_URL;
  if (pgUrl) {
    const scratch = `rvn_migration_test_${process.pid}`;
    const adminUrl = new URL(pgUrl);
    adminUrl.pathname = '/postgres';
    const scratchUrl = new URL(pgUrl);
    scratchUrl.pathname = `/${scratch}`;
    let admin: Pool | undefined;
    try {
      admin = new Pool({ connectionString: adminUrl.toString() });
      await admin.query(`CREATE DATABASE "${scratch}"`);
      const store = await PostgresStore.connect(scratchUrl.toString());
      check('live connect applies both migrations',
        JSON.stringify(store.appliedMigrations) === '["0001","0002"]', store.appliedMigrations);
      const probe = new Pool({ connectionString: scratchUrl.toString() });
      const { rows: migRows } = await probe.query(
        'SELECT version, name FROM schema_migrations ORDER BY version ASC',
      );
      check('schema_migrations rows recorded live',
        migRows.length === 2 && migRows[1].name === 'decisions_kind_index', migRows);
      const { rows: idxRows } = await probe.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'decisions' AND indexname = 'decisions_kind'",
      );
      check('0002 index exists live', idxRows.length === 1, idxRows);
      await probe.end();
      const again = await PostgresStore.connect(scratchUrl.toString());
      check('live reconnect is idempotent',
        JSON.stringify(again.appliedMigrations) === '["0001","0002"]', again.appliedMigrations);
      await again.close();
      await store.close();
    } catch (err) {
      check('live leg ran (skipped: no CREATE DATABASE privilege?)', false, (err as Error).message);
    } finally {
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
        await admin.end();
      }
    }
  } else {
    console.log('--- live leg: skipped (set TEST_DATABASE_URL to run against a live Postgres) ---');
  }

  // --- 6. /v1/health reports applied migrations (memory store: []) ---
  const API_PORT = 3124;
  const API = `http://127.0.0.1:${API_PORT}`;
  const api = spawn(tsx, [join(repo, 'src', 'server.ts')], {
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
    check('health reports store + migrations',
      health?.store === 'memory' && JSON.stringify(health?.migrations) === '[]', health);
  } finally {
    api.kill();
  }

  console.log(failures === 0 ? '\nmigration-test: all green' : `\nmigration-test: FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
