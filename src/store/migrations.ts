/**
 * Versioned Postgres schema migrations.
 *
 * Replaces the old CREATE-IF-NOT-EXISTS schema.sql applied at startup.
 * Migration files live in src/store/migrations/ as `<version>_<name>.sql`
 * (e.g. `0001_initial.sql`), applied in version order. Each migration runs
 * in its own transaction together with its row in `schema_migrations`, so
 * a failed migration rolls back entirely — there is no half-applied state —
 * and startup fails fast with a clear error instead of booting against a
 * schema it cannot trust (see storeFromEnv: a MigrationError is never
 * swallowed into the in-memory fallback).
 *
 * The runner only needs a pool with `query`/`connect`, so it is testable
 * without a live database (demo/migration-test.ts drives it with a fake).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A schema migration failed, or the database's migration state is inconsistent. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface Migration {
  /** Zero-padded version, e.g. '0001'. Sorts lexicographically. */
  version: string;
  /** Short slug from the filename, e.g. 'initial'. */
  name: string;
  /** The migration SQL, run in a single transaction. */
  sql: string;
}

/** Minimal pool/client surface the runner needs (pg's Pool satisfies it). */
export interface MigrationQueryResult {
  rows: Array<Record<string, unknown>>;
}
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<MigrationQueryResult>;
  release(): void;
}
export interface MigrationPool {
  query(sql: string, params?: unknown[]): Promise<MigrationQueryResult>;
  connect(): Promise<MigrationClient>;
}

const FILENAME_RE = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/;

/**
 * Parses a migration filename (`0001_initial.sql`) into its version and
 * name, or undefined when the name does not follow the convention. Files
 * that do not match are rejected by loadMigrations rather than silently
 * ignored — a misplaced file must never mean a skipped migration.
 */
export function parseMigrationFilename(filename: string): { version: string; name: string } | undefined {
  const m = FILENAME_RE.exec(filename);
  if (!m) return undefined;
  return { version: m[1], name: m[2] };
}

/**
 * Validates a migration set: versions unique, sorted ascending, and
 * contiguous from 1 with no gaps (a gap means a migration file was lost,
 * and applying a later migration without its predecessor is never safe).
 * Throws MigrationError naming the problem.
 */
export function validateMigrationSet(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  let prev = 0;
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new MigrationError(`duplicate migration version ${m.version} (${m.name})`);
    }
    seen.add(m.version);
    const n = Number(m.version);
    if (!Number.isInteger(n) || n <= prev) {
      throw new MigrationError(
        `migrations out of order: ${m.version} (${m.name}) does not follow ${String(prev).padStart(4, '0')}`,
      );
    }
    prev = n;
  }
  if (migrations.length > 0 && Number(migrations[0].version) !== 1) {
    throw new MigrationError(
      `first migration must be version 0001, found ${migrations[0].version} (${migrations[0].name})`,
    );
  }
  if (migrations.length > 0 && Number(migrations[migrations.length - 1].version) !== migrations.length) {
    throw new MigrationError(
      `migration versions are not contiguous: ${migrations.length} file(s) but highest version is ` +
        `${migrations[migrations.length - 1].version} — a migration file is missing`,
    );
  }
}

/**
 * Loads every `*.sql` file in `dir` as a Migration, sorted by version and
 * validated. Throws MigrationError on a misnamed file, a duplicate version,
 * a gap, or an unreadable directory.
 */
export function loadMigrations(dir: string): Migration[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    throw new MigrationError(`cannot read migrations directory ${dir}: ${(err as Error).message}`);
  }
  const migrations: Migration[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.sql')) continue;
    const parsed = parseMigrationFilename(file);
    if (!parsed) {
      throw new MigrationError(
        `migration file ${file} does not match the <version>_<name>.sql convention (e.g. 0001_initial.sql)`,
      );
    }
    migrations.push({ ...parsed, sql: readFileSync(join(dir, file), 'utf8') });
  }
  migrations.sort((a, b) => Number(a.version) - Number(b.version));
  validateMigrationSet(migrations);
  return migrations;
}

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * Brings the database up to the given migration set and returns the full
 * list of applied versions (oldest first). Already-applied migrations are
 * skipped; each pending one runs in its own transaction together with its
 * `schema_migrations` row, so a failure rolls the migration back and the
 * error names the migration that failed. Throws MigrationError when the
 * database has applied a version the files do not know (code downgrade),
 * or when the applied versions are not a prefix of the file set (a gap —
 * e.g. 0003 applied while 0002 is not — which must never be papered over).
 */
export async function applyMigrations(
  pool: MigrationPool,
  migrations: readonly Migration[],
  log: (msg: string) => void = () => undefined,
): Promise<string[]> {
  validateMigrationSet(migrations);
  await pool.query(CREATE_MIGRATIONS_TABLE);
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  const applied = rows.map((r) => String(r.version));

  const known = new Set(migrations.map((m) => m.version));
  for (const v of applied) {
    if (!known.has(v)) {
      throw new MigrationError(
        `database has applied migration ${v}, which is not in the migration files — ` +
          `the code may have been downgraded; refusing to continue`,
      );
    }
  }
  for (let i = 0; i < applied.length; i++) {
    if (applied[i] !== migrations[i].version) {
      throw new MigrationError(
        `database has applied migration ${applied[i]} but not ${migrations[i].version} ` +
          `(${migrations[i].name}) — the applied set is not a prefix of the migration files; ` +
          `restore the missing migration before starting`,
      );
    }
  }

  const pending = migrations.slice(applied.length);
  for (const m of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      await client.query('COMMIT');
      log(`migration ${m.version} (${m.name}) applied`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new MigrationError(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return migrations.map((m) => m.version);
}
