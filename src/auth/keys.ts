/**
 * API-key authentication (v0.29.0, slice 1 of the API-key authentication
 * item).
 *
 * Keys are issued per agentId and stored only as SHA-256 hashes — the raw
 * key is shown once, at issue time, and never again. Verification is a
 * constant-time comparison of the presented key's hash against the stored
 * hash, so a wrong key and a missing key are indistinguishable to the
 * caller (both 401) and the comparison itself leaks nothing through
 * timing.
 *
 * The operator key is a single env-seeded key (`RVN_OPERATOR_API_KEY`,
 * agentId 'operator') that bootstraps the admin surface: it is the only
 * credential that may issue, list, or revoke keys. It is verified in
 * memory, never written to the store, so it works on a fresh deployment
 * before any key has been issued.
 *
 * Auth is off by default: with nothing configured the API stays
 * unauthenticated (the localhost demo posture the rest of the suite
 * relies on) and logs a loud warning. It turns on when
 * `RVN_AUTH_ENABLED=true` or when an operator key is set — either way
 * the server says so at boot and `/v1/health` reports the mode.
 *
 * Remainder (slice 2): the MCP server and LangChain client passing the
 * key through (`RVN_API_KEY` / an `api_key` client argument), and a
 * per-key scope so a key can be read-only.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** The public prefix every issued key carries, so keys are recognizable. */
export const API_KEY_PREFIX = 'rvn_';

/** Agent id the env-seeded operator key is bound to. */
export const OPERATOR_AGENT_ID = 'operator';

/**
 * A stored API key. Only the hash is persisted; `keyPrefix` (the first 8
 * characters after `rvn_`) lets an operator identify a key in listings
 * without ever seeing the key itself. `revokedAtMs` is set instead of
 * deleting the record, so a revoked key stays auditable.
 */
export interface ApiKeyRecord {
  id: string;
  agentId: string;
  keyHash: string;
  keyPrefix: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

/** What an issue call returns: the raw key (shown once) plus its record. */
export interface IssuedApiKey {
  key: string;
  record: ApiKeyRecord;
}

/** SHA-256 hex of a presented key — the only form ever compared or stored. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Issue a key for an agent. The raw key is `rvn_` + 32 random hex chars
 * (128 bits of entropy); the record carries only its hash. Callers must
 * show the raw key to the operator exactly once — it cannot be recovered
 * from the record afterwards.
 */
export function generateApiKey(agentId: string, nowMs: number = Date.now()): IssuedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  const record: ApiKeyRecord = {
    id: randomUUID(),
    agentId,
    keyHash: hashApiKey(key),
    keyPrefix: key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8),
    createdAtMs: nowMs,
  };
  return { key, record };
}

/**
 * Constant-time verification of a presented key against a stored record.
 * A revoked record never verifies; a malformed record (bad hash shape)
 * never verifies and never throws. Comparing hashes of different lengths
 * is not constant-time, but both sides are fixed-length hex digests, so a
 * length mismatch means the record is corrupt and the answer is false.
 */
export function verifyApiKey(record: ApiKeyRecord | undefined, presentedKey: string): boolean {
  if (!record || record.revokedAtMs !== undefined) return false;
  const presentedHash = hashApiKey(presentedKey);
  const expected = Buffer.from(record.keyHash, 'utf8');
  const actual = Buffer.from(presentedHash, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** The public view of a key: everything except the hash. */
export function publicApiKey(record: ApiKeyRecord): Omit<ApiKeyRecord, 'keyHash'> {
  const { keyHash: _hash, ...rest } = record;
  return rest;
}

/**
 * Auth configuration resolved from the environment, lenient like the
 * webhook and rate-limit config: a malformed value degrades to the safe
 * default instead of crashing startup.
 *
 * - `RVN_AUTH_ENABLED`: 'true' turns auth on; anything else leaves it
 *   off unless an operator key is set.
 * - `RVN_OPERATOR_API_KEY`: the env-seeded operator key. Setting it
 *   turns auth on (an operator key with auth off would be dead config).
 *   A key shorter than 16 characters is ignored entirely — it never
 *   becomes an operator key — so a typo'd short key cannot silently
 *   lock the admin surface behind a weak credential.
 */
export interface AuthConfig {
  enabled: boolean;
  /** SHA-256 hash of the operator key, or undefined when none is set. */
  operatorKeyHash?: string;
  /** First 8 chars of the operator key (after `rvn_` if present), for logs. */
  operatorKeyPrefix?: string;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const rawOperator = env.RVN_OPERATOR_API_KEY;
  let operatorKeyHash: string | undefined;
  let operatorKeyPrefix: string | undefined;
  if (rawOperator && rawOperator.length >= 16) {
    operatorKeyHash = hashApiKey(rawOperator);
    const bare = rawOperator.startsWith(API_KEY_PREFIX)
      ? rawOperator.slice(API_KEY_PREFIX.length)
      : rawOperator;
    operatorKeyPrefix = bare.slice(0, 8);
  }
  const enabled = env.RVN_AUTH_ENABLED === 'true' || operatorKeyHash !== undefined;
  return { enabled, operatorKeyHash, operatorKeyPrefix };
}

/**
 * Verify a presented key against the env-seeded operator key, when one
 * is configured. Constant-time, like verifyApiKey; a missing operator
 * key never verifies.
 */
export function verifyOperatorKey(config: AuthConfig, presentedKey: string): boolean {
  if (!config.operatorKeyHash) return false;
  const presentedHash = hashApiKey(presentedKey);
  const expected = Buffer.from(config.operatorKeyHash, 'utf8');
  const actual = Buffer.from(presentedHash, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Extract the token from an `Authorization: Bearer <key>` header. */
export function parseBearerHeader(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match ? match[1] : undefined;
}
