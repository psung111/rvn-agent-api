import { randomUUID } from 'node:crypto';
import type { RvnPolicy } from './types.js';

/** How a stored policy version was replaced. */
export type PolicyReplacementSource = 'put' | 'preset' | 'rollback';

/**
 * One superseded policy version (v0.35.0): the policy that was live for an
 * agent, snapshotted at the moment it was replaced, so a bad change is one
 * rollback call to undo instead of a re-typed PUT. `preset` names the
 * preset that produced this version (when it came from a preset apply);
 * `sourceVersionId` names the version a rollback restored from (when this
 * version was replaced by a rollback).
 */
export interface PolicyVersion {
  versionId: string;
  agentId: string;
  policy: RvnPolicy;
  replacedAtMs: number;
  replacedBy: PolicyReplacementSource;
  preset?: string;
  sourceVersionId?: string;
}

export const DEFAULT_POLICY_HISTORY_LIMIT = 10;
export const MIN_POLICY_HISTORY_LIMIT = 1;
export const MAX_POLICY_HISTORY_LIMIT = 100;

/**
 * Lenient env parsing, like the webhook / rate-limit / retention config:
 * `RVN_POLICY_HISTORY_LIMIT` is the number of superseded versions kept per
 * agent (default 10, range 1..100). Malformed values fall back to the
 * default, never a startup crash.
 */
export function policyHistoryLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RVN_POLICY_HISTORY_LIMIT;
  if (raw === undefined) return DEFAULT_POLICY_HISTORY_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_POLICY_HISTORY_LIMIT || n > MAX_POLICY_HISTORY_LIMIT) {
    return DEFAULT_POLICY_HISTORY_LIMIT;
  }
  return n;
}

/** Snapshot a superseded policy as a history version. Pure. */
export function newPolicyVersion(
  previous: RvnPolicy,
  replacedBy: PolicyReplacementSource,
  replacedAtMs: number,
  extra: { preset?: string; sourceVersionId?: string } = {},
): PolicyVersion {
  return {
    versionId: randomUUID(),
    agentId: previous.agentId,
    policy: previous,
    replacedAtMs,
    replacedBy,
    ...(extra.preset !== undefined ? { preset: extra.preset } : {}),
    ...(extra.sourceVersionId !== undefined ? { sourceVersionId: extra.sourceVersionId } : {}),
  };
}

/**
 * Keep only the newest `limit` versions. Pure; input is newest first and
 * the output keeps that order. Callers that hold versions oldest-first
 * must reverse before calling.
 */
export function pruneVersions(versions: PolicyVersion[], limit: number): PolicyVersion[] {
  return versions.slice(0, Math.max(limit, 1));
}
