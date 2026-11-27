/**
 * wallet-test: checks for the wallet balances endpoint (v0.38.0).
 *
 *  pnpm test:wallet
 *
 * Units: the mock node's listWalletBalances (fresh wallet, RVN fee
 * debiting, sorting, units carriage, transfer keeping the mock total),
 * and the real client's listWalletBalances against a stubbed fetch
 * (verbose listmyassets entries, the plain-number fallback through
 * getassetdata, zero-balance entries skipped, a null listmyassets, and
 * a throwing node rejecting so the route can answer 502).
 *
 * Integration: boots the real API as a child process (MOCK_RVN=true)
 * and asserts:
 *   - a fresh wallet reports 1,000,000 RVN and no assets
 *   - issuing assets makes them appear with the right balance and
 *     units, sorted by name, with the RVN fee debited
 *   - balance reads are pure: no audit entries, no pending intents
 *   - a second, auth-on API: keyless reads 401, a read-only key reads
 *     200, a write-only key 403s (the route is a GET, so `read` scope
 *     suffices), the operator key reads 200
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import { RvnRpcClient } from '../src/rvn/client.js';
import { RVN_BASE_UNITS_PER_COIN } from '../src/policy/funding.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3126;
const API2_PORT = 3127;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const DEST = 'mtest1wallet000001xxxxxxxxxxxx';
const OPERATOR_KEY = 'rvn_operator-testkey-0123456789abcdef';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function bootApi(port: number, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(port), MOCK_RVN: 'true', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  const api = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${api}/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not come up in time');
}

async function get(api: string, path: string, key?: string) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${api}${path}`, { headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function post(api: string, path: string, body: unknown, key?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function put(api: string, path: string, body: unknown, key?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${api}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  // ================= mock units =================
  const mock = new MockRvnNode();
  const fresh = await mock.listWalletBalances();
  check('mock fresh wallet: 1,000,000 RVN, no assets',
    fresh.rvnBaseUnits === (1_000_000n * RVN_BASE_UNITS_PER_COIN).toString() && fresh.assets.length === 0,
    fresh);
  await mock.issueAsset({ name: 'WALLETCOIN', qty: '1000', toAddress: DEST, units: 2 });
  const afterIssue = await mock.listWalletBalances();
  check('mock issue debits the 500 RVN fee + 5,000 sat miner fee and lists the asset with balance + units',
    afterIssue.rvnBaseUnits === ((999_500n * RVN_BASE_UNITS_PER_COIN) - 5_000n).toString() &&
    afterIssue.assets.length === 1 &&
    afterIssue.assets[0]?.name === 'WALLETCOIN' &&
    afterIssue.assets[0]?.balanceBaseUnits === '1000' &&
    afterIssue.assets[0]?.units === 2,
    afterIssue);
  await mock.issueAsset({ name: 'ZEBRA', qty: '7', toAddress: DEST });
  await mock.issueAsset({ name: 'ALPHA', qty: '9', toAddress: DEST });
  const sorted = await mock.listWalletBalances();
  check('mock assets sorted by name',
    sorted.assets.map((a) => a.name).join(',') === 'ALPHA,WALLETCOIN,ZEBRA', sorted.assets);
  await mock.transferAsset('WALLETCOIN', '400', 'mtest1other000002xxxxxxxxxxxx');
  const afterTransfer = await mock.listWalletBalances();
  check('mock transfer keeps the wallet total (all ledger balances are wallet-held)',
    afterTransfer.assets.find((a) => a.name === 'WALLETCOIN')?.balanceBaseUnits === '1000',
    afterTransfer.assets);
  await mock.issueUniqueAsset({ name: 'WALLETCOIN#ONE', toAddress: DEST });
  const afterUnique = await mock.listWalletBalances();
  const unique = afterUnique.assets.find((a) => a.name === 'WALLETCOIN#ONE');
  check('mock unique asset listed as a singleton (balance 1, units 0)',
    unique?.balanceBaseUnits === '1' && unique?.units === 0, afterUnique.assets);

  // ================= real-client units (stubbed fetch) =================
  const realFetch = globalThis.fetch;
  try {
    const stub = async (url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: unknown[] };
      let result: unknown;
      if (body.method === 'listmyassets') {
        result = {
          FOO: { amount: 12.5, units: 2 },
          BAR: 3,
          ZERO: { amount: 0, units: 0 },
        };
      } else if (body.method === 'getassetdata') {
        result = { name: 'BAR', amount: 3, units: 0, reissuable: 1 };
      } else if (body.method === 'getbalance') {
        result = 250.5;
      } else {
        throw new Error(`unexpected RPC ${body.method}`);
      }
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    };
    globalThis.fetch = stub as unknown as typeof fetch;
    const client = new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' });
    const balances = await client.listWalletBalances();
    check('real client: verbose + plain-number entries converted, sorted, zero skipped',
      balances.rvnBaseUnits === '25050000000' &&
      balances.assets.length === 2 &&
      balances.assets[0]?.name === 'BAR' &&
      balances.assets[0]?.balanceBaseUnits === '3' &&
      balances.assets[0]?.units === 0 &&
      balances.assets[1]?.name === 'FOO' &&
      balances.assets[1]?.balanceBaseUnits === '1250' &&
      balances.assets[1]?.units === 2,
      balances);

    // listmyassets null -> no assets, RVN still reported.
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      const result = body.method === 'listmyassets' ? null : 250.5;
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const empty = await new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' }).listWalletBalances();
    check('real client: null listmyassets means no assets',
      empty.assets.length === 0 && empty.rvnBaseUnits === '25050000000', empty);

    // A throwing node rejects, so the route can answer 502.
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    let threw = false;
    try {
      await new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' }).listWalletBalances();
    } catch (err) {
      threw = err instanceof Error && err.message === 'connection refused';
    }
    check('real client: a down node rejects (route turns it into 502)', threw);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ================= booted-API integration =================
  let child1: ChildProcess | undefined;
  let child2: ChildProcess | undefined;
  try {
    child1 = await bootApi(API1_PORT);
    const freshApi = await get(API1, '/v1/wallet/balances');
    check('API fresh wallet: 1,000,000 RVN, no assets',
      freshApi.status === 200 &&
      freshApi.json?.rvnBaseUnits === (1_000_000n * RVN_BASE_UNITS_PER_COIN).toString() &&
      Array.isArray(freshApi.json?.assets) && freshApi.json.assets.length === 0,
      freshApi);

    // The default policy allows no destinations, so issues to a fresh
    // address hold; provision the agent's own wallet address and
    // allowlist it first (the funding test's pattern), then the issues
    // ALLOW — and the agent-scoped balances list them, since the coins
    // sit at that address (v0.42.0: the asset list is per-address too).
    const address = (await get(API1, '/v1/wallet/address/agent-1')).json?.address as string;
    check('agent-1 wallet address provisioned', typeof address === 'string' && address.length > 0, address);
    const basePolicy = await get(API1, '/v1/policies/agent-1');
    const putPolicy = await put(API1, '/v1/policies/agent-1', {
      ...basePolicy.json, agentId: 'agent-1', allowedDestinations: [address],
    });
    check('policy updated to allowlist the provisioned address', putPolicy.status === 200, putPolicy);
    const issued = await post(API1, '/v1/assets/issue', { name: 'INTCOIN', qty: '500', toAddress: address });
    check('API issue ALLOWs', issued.status === 200 && issued.json?.decision?.kind === 'ALLOW', issued);
    await post(API1, '/v1/assets/issue', { name: 'ZCOIN', qty: '7', toAddress: address });
    // Snapshot the audit AFTER the issues: balance reads must add nothing.
    const auditBefore = await get(API1, '/v1/audit?limit=100');
    const auditLenBefore = (auditBefore.json?.entries ?? []).length;
    // Per-agent wallets (v0.41.0; ravend wallets since v0.43.0): the
    // issues were submitted as agent-1, so they executed inside
    // agent-1's own ravend wallet — the agent-scoped read is the
    // meaningful one now. The wallet-wide read is the default
    // (operator) wallet, which the agent's activity never touches: it
    // stays at its 1,000,000 RVN seed with no assets.
    const agentBalances = await get(API1, '/v1/wallet/balances?agentId=agent-1');
    check('API per-agent balances after issues: fee + miner fee debited from agent-1, assets sorted with balances',
      agentBalances.status === 200 &&
      agentBalances.json?.rvnBaseUnits === ((999_000n * RVN_BASE_UNITS_PER_COIN) - 10_000n).toString() &&
      agentBalances.json?.assets?.length === 2 &&
      agentBalances.json.assets[0]?.name === 'INTCOIN' &&
      agentBalances.json.assets[0]?.balanceBaseUnits === '500' &&
      agentBalances.json.assets[0]?.units === 0 &&
      agentBalances.json.assets[1]?.name === 'ZCOIN' &&
      agentBalances.json.assets[1]?.balanceBaseUnits === '7',
      agentBalances);
    const apiBalances = await get(API1, '/v1/wallet/balances');
    check('API wallet-wide read is the operator wallet only: 1,000,000 RVN seed, no agent assets',
      apiBalances.status === 200 &&
      apiBalances.json?.rvnBaseUnits === (1_000_000n * RVN_BASE_UNITS_PER_COIN).toString() &&
      Array.isArray(apiBalances.json?.assets) && apiBalances.json.assets.length === 0,
      apiBalances);
    const auditAfter = await get(API1, '/v1/audit?limit=100');
    const pending = await get(API1, '/v1/intents/pending');
    check('balance reads are pure: no audit entries, no pending intents',
      (auditAfter.json?.entries ?? []).length === auditLenBefore &&
      Array.isArray(pending.json?.pending) && pending.json.pending.length === 0,
      { auditBefore: auditLenBefore, auditAfter: (auditAfter.json?.entries ?? []).length, pending: pending.json });

    // ================= auth-on leg =================
    child2 = await bootApi(API2_PORT, {
      RVN_AUTH_ENABLED: 'true',
      RVN_OPERATOR_API_KEY: OPERATOR_KEY,
    });
    const keyless = await get(API2, '/v1/wallet/balances');
    check('auth-on: keyless balance read 401s', keyless.status === 401, keyless);
    const readOnly = await post(API2, '/v1/admin/api-keys', { agentId: 'reader', scopes: ['read'] }, OPERATOR_KEY);
    check('auth-on: read-only key issued',
      readOnly.status === 200 && typeof readOnly.json?.key === 'string', readOnly);
    const readKey = readOnly.json?.key as string;
    const readOk = await get(API2, '/v1/wallet/balances', readKey);
    check('auth-on: read-only key reads balances (GET needs read scope)',
      readOk.status === 200 && readOk.json?.rvnBaseUnits === (1_000_000n * RVN_BASE_UNITS_PER_COIN).toString(),
      readOk);
    const writeOnly = await post(API2, '/v1/admin/api-keys', { agentId: 'writer', scopes: ['write'] }, OPERATOR_KEY);
    const writeKey = writeOnly.json?.key as string;
    const writeDenied = await get(API2, '/v1/wallet/balances', writeKey);
    check('auth-on: write-only key 403s on the balance read', writeDenied.status === 403, writeDenied);
    const operatorOk = await get(API2, '/v1/wallet/balances', OPERATOR_KEY);
    check('auth-on: operator key reads balances', operatorOk.status === 200, operatorOk);
  } finally {
    child1?.kill('SIGTERM');
    child2?.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nwallet balances: all checks passed');
}

await main();
