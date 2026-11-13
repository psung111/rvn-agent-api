/**
 * auth-test: checks for API-key authentication (v0.29.0, slice 1).
 *
 *  pnpm test:auth
 *
 * Boots the real API as a child process (MOCK_RVN=true) twice and asserts:
 *   - unit: key generation (format, uniqueness, hash-only storage),
 *     constant-time verification (correct / wrong / revoked / unknown /
 *     malformed), Bearer parsing, env config (default off, flag on,
 *     operator key on, short operator key ignored), operator verification,
 *     public view carries no hash
 *   - auth OFF (default): /v1/health reports auth disabled, every route
 *     works without a key, the admin surface issues keys unauthenticated
 *   - auth ON (RVN_AUTH_ENABLED=true + RVN_OPERATOR_API_KEY): /v1/health
 *     stays open and reports auth enabled; every other route 401s
 *     without a key or with a wrong key; the Telegram webhook stays open
 *     (its own secret check); the operator key issues a per-agent key
 *     (raw key shown once, listing carries no hash); the agent key
 *     submits as its own agent, defaults to it when agentId is omitted,
 *     and gets 403 acting as another agent (policy read included); a
 *     non-operator key gets 403 on the admin surface; revoking the key
 *     makes it 401 immediately; failed attempts are audited as
 *     AUTH_FAILED and the chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  API_KEY_PREFIX,
  authConfigFromEnv,
  generateApiKey,
  hashApiKey,
  parseBearerHeader,
  publicApiKey,
  verifyApiKey,
  verifyOperatorKey,
} from '../src/auth/keys.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3130;
const API = `http://127.0.0.1:${API_PORT}`;
const OPERATOR_KEY = 'rvn_operator-testkey-0123456789abcdef';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function bootApi(extraEnv: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(API_PORT), MOCK_RVN: 'true', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${API}/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not come up in time');
}

async function stopApi(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  key?: string,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const get = (path: string, key?: string) => req('GET', path, undefined, key);
const post = (path: string, body: unknown, key?: string) => req('POST', path, body, key);
const put = (path: string, body: unknown, key?: string) => req('PUT', path, body, key);

const DEST = 'RXauth1111111111111111111111111';

function basePolicy(agentId: string) {
  return {
    version: 1,
    agentId,
    maxIssueQtyBaseUnits: '100000',
    approvalAboveIssueQtyBaseUnits: '10000',
    dailyIssueBudgetBaseUnits: '500000',
    maxTransferQtyBaseUnits: '50000',
    approvalAboveTransferQtyBaseUnits: '5000',
    allowedDestinations: [DEST],
    blockedDestinations: [],
    assetNamePattern: '^[A-Z0-9._]{3,30}$',
    decisionTtlSeconds: 3600,
  };
}

async function main() {
  // --- 1. Unit: key generation, hashing, verification ---
  const issued = generateApiKey('agent-2');
  check('issued key has the rvn_ prefix and 32 hex chars',
    issued.key.startsWith(API_KEY_PREFIX) && issued.key.length === API_KEY_PREFIX.length + 32,
    issued.key);
  check('two issued keys differ', generateApiKey('agent-2').key !== issued.key);
  check('record carries the hash, not the raw key',
    issued.record.keyHash === hashApiKey(issued.key) && !JSON.stringify(issued.record).includes(issued.key));
  check('hash is deterministic', hashApiKey(issued.key) === hashApiKey(issued.key));
  check('key prefix is the first 8 chars after rvn_',
    issued.record.keyPrefix === issued.key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8));
  check('correct key verifies', verifyApiKey(issued.record, issued.key));
  check('wrong key does not verify', !verifyApiKey(issued.record, `${issued.key}x`));
  check('undefined record does not verify', !verifyApiKey(undefined, issued.key));
  check('revoked record does not verify',
    !verifyApiKey({ ...issued.record, revokedAtMs: 1 }, issued.key));
  check('malformed stored hash does not verify or throw',
    !verifyApiKey({ ...issued.record, keyHash: 'not-a-hash' }, issued.key));
  check('public view carries no hash',
    !('keyHash' in publicApiKey(issued.record)) && publicApiKey(issued.record).keyPrefix === issued.record.keyPrefix);

  check('Bearer header parses', parseBearerHeader('Bearer abc123') === 'abc123');
  check('Bearer header rejects a non-Bearer scheme', parseBearerHeader('Basic abc123') === undefined);
  check('Bearer header rejects an empty token', parseBearerHeader('Bearer ') === undefined);
  check('Bearer header rejects a missing header', parseBearerHeader(undefined) === undefined);

  check('env config defaults to auth off',
    authConfigFromEnv({}).enabled === false && authConfigFromEnv({}).operatorKeyHash === undefined);
  check('RVN_AUTH_ENABLED=true turns auth on',
    authConfigFromEnv({ RVN_AUTH_ENABLED: 'true' }).enabled === true);
  check('RVN_AUTH_ENABLED=false leaves auth off',
    authConfigFromEnv({ RVN_AUTH_ENABLED: 'false' }).enabled === false);
  const opConfig = authConfigFromEnv({ RVN_OPERATOR_API_KEY: OPERATOR_KEY });
  check('operator key turns auth on and hashes',
    opConfig.enabled === true && opConfig.operatorKeyHash === hashApiKey(OPERATOR_KEY), opConfig);
  check('short operator key is ignored entirely',
    authConfigFromEnv({ RVN_OPERATOR_API_KEY: 'short' }).enabled === false);
  check('operator key verifies', verifyOperatorKey(opConfig, OPERATOR_KEY));
  check('wrong operator key does not verify', !verifyOperatorKey(opConfig, `${OPERATOR_KEY}x`));
  check('no operator key never verifies', !verifyOperatorKey(authConfigFromEnv({}), OPERATOR_KEY));

  // --- 2. Integration: auth OFF (the default) ---
  let child = await bootApi({});
  try {
    const health = await get('/v1/health');
    check('auth-off health reports auth disabled',
      health.json?.auth?.enabled === false && health.json?.auth?.operatorKeyConfigured === false, health.json?.auth);
    const issuedOff = await post('/v1/admin/api-keys', { agentId: 'agent-2' });
    check('auth-off admin issues a key without any credential',
      issuedOff.status === 200 && typeof issuedOff.json?.key === 'string', issuedOff);
    const policyOff = await put('/v1/policies/agent-1', basePolicy('agent-1'));
    check('auth-off policy PUT works without a key', policyOff.status === 200, policyOff);
    const submitOff = await post('/v1/assets/issue', {
      name: 'AUTHCOIN', qty: '100', toAddress: DEST,
    });
    check('auth-off submit works without a key', submitOff.status === 200, submitOff);
    const listOff = await get('/v1/admin/api-keys');
    check('auth-off admin list works and carries no hash',
      listOff.status === 200 && listOff.json?.keys?.length === 1 &&
        !JSON.stringify(listOff.json.keys).includes('keyHash'), listOff.json);
  } finally {
    await stopApi(child);
  }

  // --- 3. Integration: auth ON ---
  child = await bootApi({ RVN_AUTH_ENABLED: 'true', RVN_OPERATOR_API_KEY: OPERATOR_KEY });
  try {
    const health = await get('/v1/health');
    check('auth-on health stays open and reports auth enabled',
      health.status === 200 && health.json?.auth?.enabled === true &&
        health.json?.auth?.operatorKeyConfigured === true && health.json?.auth?.keys === 0, health.json?.auth);

    const noKey = await post('/v1/assets/issue', {
      name: 'AUTHCOIN', qty: '100', toAddress: DEST,
    });
    check('no key gets 401 on a submit', noKey.status === 401, noKey);
    check('wrong key gets 401', (await get('/v1/assets', 'rvn_deadbeefdeadbeefdeadbeefdeadbeef')).status === 401);
    check('metrics are gated when auth is on', (await get('/v1/metrics')).status === 401);
    check('admin list is gated when auth is on', (await get('/v1/admin/api-keys')).status === 401);
    const tg = await post('/v1/telegram/webhook', { update_id: 1 });
    check('telegram webhook stays open without a key (its own secret check)',
      tg.status === 200 && tg.json?.ok === true, tg);

    // Operator issues a key for agent-2.
    const issuedOn = await post('/v1/admin/api-keys', { agentId: 'agent-2' }, OPERATOR_KEY);
    check('operator key issues a per-agent key',
      issuedOn.status === 200 && typeof issuedOn.json?.key === 'string' &&
        issuedOn.json?.record?.agentId === 'agent-2' && !('keyHash' in issuedOn.json.record), issuedOn);
    const agentKey = issuedOn.json.key as string;
    const healthAfter = await get('/v1/health');
    check('health counts the live key', healthAfter.json?.auth?.keys === 1, healthAfter.json?.auth);
    const policyOn = await put('/v1/policies/agent-2', basePolicy('agent-2'), OPERATOR_KEY);
    check('operator sets agent-2 policy allowlisting the destination',
      policyOn.status === 200, policyOn);

    const listOn = await get('/v1/admin/api-keys', OPERATOR_KEY);
    check('operator list shows the key prefix but no hash',
      listOn.status === 200 && listOn.json?.keys?.length === 1 &&
        listOn.json.keys[0].keyPrefix === agentKey.slice(4, 12) &&
        !JSON.stringify(listOn.json.keys).includes('keyHash') &&
        !JSON.stringify(listOn.json.keys).includes(agentKey), listOn.json);

    // The agent key works as its own agent, and only as its own agent.
    const own = await post('/v1/assets/issue', {
      agentId: 'agent-2', name: 'AUTHCOIN', qty: '100', toAddress: DEST,
    }, agentKey);
    check('agent key submits as its own agent', own.status === 200 && own.json?.intent?.agentId === 'agent-2', own);
    const omitted = await post('/v1/assets/issue', {
      name: 'AUTHCOIN2', qty: '100', toAddress: DEST,
    }, agentKey);
    check('omitted agentId defaults to the key agent',
      omitted.status === 200 && omitted.json?.intent?.agentId === 'agent-2', omitted);
    const other = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'AUTHCOIN', qty: '100', toAddress: DEST,
    }, agentKey);
    check('agent key acting as another agent gets 403', other.status === 403, other);
    check('agent key reading another agent policy gets 403',
      (await get('/v1/policies/agent-1', agentKey)).status === 403);
    check('agent key reading its own policy works',
      (await get('/v1/policies/agent-2', agentKey)).status === 200);
    check('agent key gets 403 on the admin surface',
      (await get('/v1/admin/api-keys', agentKey)).status === 403);
    check('agent key cannot issue keys',
      (await post('/v1/admin/api-keys', { agentId: 'agent-9' }, agentKey)).status === 403);
    check('operator key can act as any agent',
      (await get('/v1/policies/agent-1', OPERATOR_KEY)).status === 200);

    // Revocation takes effect immediately.
    const keyId = issuedOn.json.record.id as string;
    const revoked = await post(`/v1/admin/api-keys/${keyId}/revoke`, {}, OPERATOR_KEY);
    check('operator revokes the key',
      revoked.status === 200 && revoked.json?.record?.revokedAtMs !== undefined, revoked);
    check('revoked key gets 401 immediately',
      (await get('/v1/assets', agentKey)).status === 401);
    const listAfter = await get('/v1/admin/api-keys', OPERATOR_KEY);
    check('revoked key stays listed with its revocation time',
      listAfter.json?.keys?.[0]?.revokedAtMs !== undefined, listAfter.json);
    const healthRevoked = await get('/v1/health');
    check('health counts no live keys after revocation', healthRevoked.json?.auth?.keys === 0, healthRevoked.json?.auth);
    check('revoking an unknown key 404s',
      (await post('/v1/admin/api-keys/no-such-id/revoke', {}, OPERATOR_KEY)).status === 404);
    check('issuing a key without an agentId 400s',
      (await post('/v1/admin/api-keys', {}, OPERATOR_KEY)).status === 400);

    // Failed attempts are audited and the chain stays valid.
    const audit = await get('/v1/audit?limit=50', OPERATOR_KEY);
    const kinds = (audit.json?.entries ?? []).map((e: any) => e.kind);
    check('failed auth attempts are audited as AUTH_FAILED', kinds.includes('AUTH_FAILED'), kinds);
    check('key issue and revoke are audited',
      kinds.includes('API_KEY_ISSUED') && kinds.includes('API_KEY_REVOKED'), kinds);
    check('audit chain stays valid', audit.json?.chainValid === true, audit.json);
  } finally {
    await stopApi(child);
  }

  console.log(failures === 0 ? `\nall checks passed` : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
