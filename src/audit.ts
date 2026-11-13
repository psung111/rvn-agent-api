import { createHash } from 'node:crypto';

export type AuditKind = 'DECISION' | 'APPROVAL' | 'DENIAL' | 'APPROVAL_NOTIFICATION' | 'APPROVAL_NOTIFICATION_FAILED' | 'EXECUTION' | 'EXECUTION_SKIPPED' | 'EXECUTION_FAILED' | 'WEBHOOK_DELIVERY' | 'WEBHOOK_DELIVERY_FAILED' | 'AUDIT_ARCHIVED' | 'AUTH_FAILED' | 'API_KEY_ISSUED' | 'API_KEY_REVOKED';

export interface AuditEntry {
  seq: number;
  prevHash: string;
  hash: string;
  atMs: number;
  kind: AuditKind;
  intentId: string;
  agentId: string;
  detail: Record<string, unknown>;
}

function hashEntry(seq: number, prevHash: string, atMs: number, kind: AuditKind, intentId: string, detail: Record<string, unknown>): string {
  const payload = JSON.stringify({ seq, prevHash, atMs, kind, intentId, detail });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Recursively key-sort an object so its JSON form is canonical. The Postgres
 * audit store keeps detail as TEXT so the canonical bytes round-trip exactly;
 * hashing the canonical form keeps both backends verifying identically.
 * Arrays keep their order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Build the next chained entry given its predecessor (undefined for the
 * genesis entry). Shared by the in-memory and Postgres audit stores so both
 * produce byte-identical chains.
 */
export function makeChainedEntry(
  prev: AuditEntry | undefined,
  kind: AuditKind,
  intentId: string,
  agentId: string,
  detail: Record<string, unknown> = {},
  atMs: number = Date.now(),
): AuditEntry {
  const prevHash = prev ? prev.hash : 'GENESIS';
  const seq = prev ? prev.seq + 1 : 0;
  // Hash and store the canonical form so every backend verifies identically.
  const canonDetail = canonicalize(detail) as Record<string, unknown>;
  const hash = hashEntry(seq, prevHash, atMs, kind, intentId, canonDetail);
  return { seq, prevHash, hash, atMs, kind, intentId, agentId, detail: canonDetail };
}

/**
 * Returns the first broken seq in ascending order, or -1 if the chain is intact.
 * `anchorPrevHash` is the prevHash the first entry must link to — 'GENESIS'
 * for a chain from its head, or the archived head hash for a chain whose
 * oldest entries were pruned away (v0.24.0 retention). The hash of every
 * entry is still recomputed, so anchoring never hides tampering inside the
 * retained slice; it only states where the slice starts.
 */
export function verifyChain(entries: AuditEntry[], anchorPrevHash = 'GENESIS'): number {
  let prevHash = anchorPrevHash;
  for (const e of entries) {
    if (e.prevHash !== prevHash) return e.seq;
    if (hashEntry(e.seq, e.prevHash, e.atMs, e.kind, e.intentId, e.detail) !== e.hash) return e.seq;
    prevHash = e.hash;
  }
  return -1;
}

/** Append-only, hash-chained audit log. Tampering with any entry breaks the chain. */
export class AuditLog {
  private entries: AuditEntry[] = [];

  append(
    kind: AuditKind,
    intentId: string,
    agentId: string,
    detail: Record<string, unknown> = {},
  ): AuditEntry {
    const entry = makeChainedEntry(this.entries[this.entries.length - 1], kind, intentId, agentId, detail);
    this.entries.push(entry);
    return entry;
  }

  /** Returns the first broken seq, or -1 if the chain is intact. */
  verify(): number {
    // Anchor at the oldest retained entry's prevHash: after a retention
    // prune that is the archived head hash, not 'GENESIS' — and for an
    // unpruned chain the oldest entry IS the genesis entry, so the anchor
    // is 'GENESIS' and behavior is unchanged.
    return verifyChain(this.entries, this.entries[0]?.prevHash ?? 'GENESIS');
  }

  /** Oldest retained entry, or undefined when the chain is empty. */
  oldest(): AuditEntry | undefined {
    return this.entries[0];
  }

  /** Entries older than cutoffMs, ascending by seq, capped at limit. */
  beforeMs(cutoffMs: number, limit = 10_000): AuditEntry[] {
    const n = Math.min(Math.max(limit, 1), 50_000);
    return this.entries.filter((e) => e.atMs < cutoffMs).slice(0, n);
  }

  /**
   * Delete entries with seq < beforeSeq, always keeping the newest entry
   * as the chain anchor for future appends. Returns the deleted count.
   * The caller must have archived the deleted slice first (see
   * src/audit/archive.ts) — prune on its own loses history.
   */
  prune(beforeSeq: number): number {
    if (this.entries.length <= 1) return 0;
    const newestSeq = this.entries[this.entries.length - 1].seq;
    const keepFrom = Math.min(beforeSeq, newestSeq);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.seq >= keepFrom);
    return before - this.entries.length;
  }

  tail(limit = 50): AuditEntry[] {
    return this.entries.slice(-Math.min(limit, 500)).reverse();
  }

  /** Every retained entry, ascending by seq. */
  all(): AuditEntry[] {
    return [...this.entries];
  }
}
