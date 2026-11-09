/**
 * Monthly partitioning for the Postgres audit_entries table (v0.25.0,
 * migration 0003_audit_entries_partitioning).
 *
 * audit_entries is PARTITION BY RANGE (at_ms) with one partition per UTC
 * calendar month, named `audit_entries_YYYY_MM` with bounds in epoch
 * milliseconds. Monthly partitions are what make the v0.24.0 retention
 * flow cheap at scale: time-range reads (beforeMs, the archive scan)
 * prune whole partitions instead of scanning the chain, and a future
 * retention slice can drop an old month as one DDL instead of a
 * row-by-row DELETE.
 *
 * Two places create partitions:
 *   - migration 0003 creates one per month holding data (plus the current
 *     month and the next two) as part of the table rebuild;
 *   - PostgresAuditStore.append creates the entry's month on demand
 *     (inside its advisory-locked transaction), so a month boundary can
 *     never fail an append.
 *
 * The partition name is built from integers only, so interpolating it
 * into the DDL below is safe — there is no user input anywhere near it.
 */
export interface AuditPartition {
  /** Partition table name, e.g. 'audit_entries_2026_11'. */
  name: string;
  /** Inclusive lower bound: epoch ms at the UTC start of the month. */
  fromMs: number;
  /** Exclusive upper bound: epoch ms at the UTC start of the next month. */
  toMs: number;
}

/** The monthly partition holding an entry written at `atMs` (UTC months). */
export function auditPartitionFor(atMs: number): AuditPartition {
  const d = new Date(atMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based
  return {
    name: `audit_entries_${year}_${String(month + 1).padStart(2, '0')}`,
    fromMs: Date.UTC(year, month, 1),
    toMs: Date.UTC(year, month + 1, 1),
  };
}

/**
 * CREATE TABLE ... PARTITION OF statement for a partition of the live
 * `audit_entries` table. IF NOT EXISTS makes it a no-op when the month
 * already has a partition (the common case on append).
 */
export function auditPartitionDdl(part: AuditPartition): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${part.name} ` +
    `PARTITION OF audit_entries FOR VALUES FROM (${part.fromMs}) TO (${part.toMs})`
  );
}
