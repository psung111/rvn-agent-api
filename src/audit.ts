import { createHash } from 'node:crypto';

export type AuditKind = 'DECISION' | 'APPROVAL' | 'DENIAL' | 'APPROVAL_NOTIFICATION' | 'APPROVAL_NOTIFICATION_FAILED' | 'EXECUTION' | 'EXECUTION_SKIPPED' | 'EXECUTION_FAILED';

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

/** Append-only, hash-chained audit log. Tampering with any entry breaks the chain. */
export class AuditLog {
  private entries: AuditEntry[] = [];

  append(
    kind: AuditKind,
    intentId: string,
    agentId: string,
    detail: Record<string, unknown> = {},
  ): AuditEntry {
    const prev = this.entries[this.entries.length - 1];
    const prevHash = prev ? prev.hash : 'GENESIS';
    const seq = this.entries.length;
    const atMs = Date.now();
    const payload = JSON.stringify({ seq, prevHash, atMs, kind, intentId, detail });
    const hash = createHash('sha256').update(payload).digest('hex');
    const entry: AuditEntry = { seq, prevHash, hash, atMs, kind, intentId, agentId, detail };
    this.entries.push(entry);
    return entry;
  }

  /** Returns the first broken seq, or -1 if the chain is intact. */
  verify(): number {
    let prevHash = 'GENESIS';
    for (const e of this.entries) {
      const payload = JSON.stringify({
        seq: e.seq, prevHash: e.prevHash, atMs: e.atMs,
        kind: e.kind, intentId: e.intentId, detail: e.detail,
      });
      if (e.prevHash !== prevHash) return e.seq;
      if (createHash('sha256').update(payload).digest('hex') !== e.hash) return e.seq;
      prevHash = e.hash;
    }
    return -1;
  }

  tail(limit = 50): AuditEntry[] {
    return this.entries.slice(-Math.min(limit, 500)).reverse();
  }
}
