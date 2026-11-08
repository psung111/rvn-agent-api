/**
 * Audit archive: export a contiguous slice of the hash-chained audit log to
 * cold storage with a chain-verification proof, so the live chain can be
 * pruned (retention) without losing verifiability.
 *
 * An archive is a self-contained document: the entries, the seq range they
 * cover, the prevHash of the first entry, and the hash of the last entry
 * (the head hash). The retained chain stays verifiable because its oldest
 * entry's prevHash must equal the archive's headHash and its seq must be
 * lastSeq + 1 — that is the continuity proof (verifyContinuity). The
 * archive's own entries verify from its prevHash ('GENESIS' when the
 * archive starts at the chain head), so the full history — archive +
 * retained chain — verifies end to end across the boundary.
 *
 * Retention policy (RVN_AUDIT_RETENTION_DAYS, default 90) is the cutoff
 * the POST /v1/audit/archive endpoint uses when no explicit beforeMs is
 * given. Parsing is lenient like the webhook and rate-limit config: a
 * malformed value degrades to the default, never a startup crash.
 */
import { verifyChain, type AuditEntry } from '../audit.js';

export interface AuditArchive {
  version: 1;
  exportedAtMs: number;
  firstSeq: number;
  lastSeq: number;
  /** prevHash of the first archived entry ('GENESIS' when the archive starts at the chain head). */
  prevHash: string;
  /** Hash of the last archived entry — the anchor the retained chain must continue from. */
  headHash: string;
  entries: AuditEntry[];
}

/** Maximum entries archived (and pruned) by one POST /v1/audit/archive call; call again to drain more. */
export const MAX_ARCHIVE_ENTRIES = 10_000;

export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 3650;

export interface RetentionConfig {
  retentionDays: number;
  /** Directory archive JSON files are written to (relative paths resolve against the process cwd). */
  archiveDir: string;
}

export function retentionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const rawDays = Number(env.RVN_AUDIT_RETENTION_DAYS);
  const retentionDays =
    Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= MAX_RETENTION_DAYS
      ? rawDays
      : DEFAULT_RETENTION_DAYS;
  const dir =
    typeof env.RVN_AUDIT_ARCHIVE_DIR === 'string' && env.RVN_AUDIT_ARCHIVE_DIR.trim()
      ? env.RVN_AUDIT_ARCHIVE_DIR.trim()
      : 'audit-archives';
  return { retentionDays, archiveDir: dir };
}

/**
 * Build an archive document from a contiguous run of entries. Throws when
 * the list is empty, the seqs are not contiguous, or the chain inside the
 * slice is broken (naming the first broken seq) — a broken chain must never
 * be archived and pruned away.
 */
export function buildArchive(entries: AuditEntry[], exportedAtMs: number = Date.now()): AuditArchive {
  if (entries.length === 0) throw new Error('cannot archive an empty entry list');
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].seq !== entries[i - 1].seq + 1) {
      throw new Error(
        `archive entries must be contiguous: seq ${entries[i].seq} follows ${entries[i - 1].seq}`,
      );
    }
  }
  const broken = verifyChain(entries, entries[0].prevHash);
  if (broken !== -1) throw new Error(`archive chain is broken at seq ${broken}`);
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    version: 1,
    exportedAtMs,
    firstSeq: first.seq,
    lastSeq: last.seq,
    prevHash: first.prevHash,
    headHash: last.hash,
    entries,
  };
}

/**
 * Verify an archive document: header (version, seq range, prevHash,
 * headHash) matches the entries, and the entries' internal chain verifies
 * from the archive's prevHash. Returns -1 when valid, otherwise the seq of
 * the first entry that fails (the first entry's seq when the header does
 * not match the entries, 0 when the document has no entries at all).
 */
export function verifyArchive(archive: AuditArchive): number {
  if (!archive || archive.version !== 1 || !Array.isArray(archive.entries) || archive.entries.length === 0) {
    return archive?.entries?.[0]?.seq ?? 0;
  }
  const entries = archive.entries;
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (archive.firstSeq !== first.seq || archive.lastSeq !== last.seq) return first.seq;
  if (archive.prevHash !== first.prevHash) return first.seq;
  if (archive.headHash !== last.hash) return first.seq;
  return verifyChain(entries, archive.prevHash);
}

/**
 * The continuity proof across the archive boundary: the retained chain
 * (ascending by seq) must start exactly where the archive ended — its
 * oldest entry links to the archive's head hash at lastSeq + 1. An empty
 * retained chain verifies vacuously (nothing left to continue).
 */
export function verifyContinuity(archive: AuditArchive, retained: AuditEntry[]): boolean {
  if (retained.length === 0) return true;
  const first = retained[0];
  return first.prevHash === archive.headHash && first.seq === archive.lastSeq + 1;
}
