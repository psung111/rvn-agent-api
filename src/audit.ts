import { createHash } from 'node:crypto';

export type AuditKind = 'DECISION' | 'APPROVAL' | 'DENIAL' | 'APPROVAL_NOTIFICATION' | 'APPROVAL_NOTIFICATION_FAILED' | 'EXECUTION' | 'EXECUTION_SKIPPED' | 'EXECUTION_FAILED' | 'WEBHOOK_DELIVERY' | 'WEBHOOK_DELIVERY_FAILED';

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

/** Returns the first broken seq in ascending order, or -1 if the chain is intact. */
export function verifyChain(entries: AuditEntry[]): number {
  let prevHash = 'GENESIS';
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
    return verifyChain(this.entries);
  }

  tail(limit = 50): AuditEntry[] {
    return this.entries.slice(-Math.min(limit, 500)).reverse();
  }
}
