/**
 * per-agent-wallet-test: checks for per-agent wallets (v0.41.0).
 *
 *  pnpm test:wallets
 *
 * Units: the mock node's per-address RVN balances (operator seed, agent
 * label seeding, throwaways unseeded, per-address fee debiting and
 * isolation, wallet-wide total as the sum), the wallets module
 * (getOrCreate stable per agent, distinct per agent, label passed to
 * the node, invalid ids and node/store failures throw, read-only get
 * never provisions), and the real client's per-address reads against a
 * stubbed fetch (listunspent sums for getRvnBalance, the
 * listassetbalancesbyaddress leg of listWalletBalances).
 *
 * Integration: boots the real API as a child process (MOCK_RVN=true)
 * and asserts:
 *   - GET /v1/wallet/address/:agentId is stable per agent, distinct
 *     across agents
 *   - GET /v1/wallet/balances?agentId= scopes the RVN figure to the
 *     agent: two issues debit only the issuing agent's address, the
 *     other agent's balance is untouched, the wallet-wide total is the
 *     sum (operator + both agents)
 *   - simulate never provisions an address (the wallet-wide total does
 *     not move), and a later GET provisions exactly once
 *   - funding isolation on a 600 RVN mock: agent-1 issues once, then
 *     DENYs on its own drained balance while agent-2 still ALLOWs —
 *     even though the wallet-wide total could still fund the issue
 *   - an auth-on API: keyless 401s, a per-agent key reads its own
 *     address/balances and 403s on another agent's, the operator reads
 *     any
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import { RvnRpcClient } from '../src/rvn/client.js';
import { AGENT_WALLET_LABEL_PREFIX, getOrCreateWalletAddress, getWalletAddress } from '../src/rvn/wallets.js';
import type { RvnNode } from '../src/rvn/types.js';
import { MemoryStore } from '../src/store/memory.js';
import { RVN_BASE_UNITS_PER_COIN } from '../src/policy/funding.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3128;
const API2_PORT = 3129;
const API3_PORT = 3130;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const API3 = `http://127.0.0.1:${API3_PORT}`;
const OPERATOR_KEY = 'rvn_operator-testkey-0123456789abcdef';
const ONE_MILLION_RVN = (1_000_000n * RVN_BASE_UNITS_PER_COIN).toString();
const ISSUE_FEE_PLUS_MINER = (500n * RVN_BASE_UNITS_PER_COIN + 5_000n).toString();

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

async function req(api: string, method: string, path: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  // ================= mock units: per-address RVN =================
  const mock = new MockRvnNode();
  check('mock fresh wallet-wide RVN is the 1,000,000 operator seed',
    (await mock.getRvnBalance()) === ONE_MILLION_RVN, await mock.getRvnBalance());
  check('mock unknown address holds 0 RVN',
    (await mock.getRvnBalance('mtest1nobody000000xxxxxxxxxxxx')) === '0');

  const agentA = await mock.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-a`);
  const agentB = await mock.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-b`);
  check('mock agent-labelled addresses are seeded with 1,000,000 RVN each',
    (await mock.getRvnBalance(agentA)) === ONE_MILLION_RVN &&
    (await mock.getRvnBalance(agentB)) === ONE_MILLION_RVN,
    { agentA: await mock.getRvnBalance(agentA), agentB: await mock.getRvnBalance(agentB) });
  check('mock wallet-wide total is the sum of the seeded addresses (3,000,000 RVN)',
    (await mock.getRvnBalance()) === (3_000_000n * RVN_BASE_UNITS_PER_COIN).toString(),
    await mock.getRvnBalance());

  const throwaway = await mock.getNewAddress();
  check('mock throwaway address (no agent label) is not seeded',
    (await mock.getRvnBalance(throwaway)) === '0' &&
    (await mock.getRvnBalance()) === (3_000_000n * RVN_BASE_UNITS_PER_COIN).toString());

  await mock.issueAsset({ name: 'ISOLCOIN', qty: '100', toAddress: throwaway, fromAddress: agentA });
  check('mock issue debits only the issuing agent address (500 RVN + 5,000 sat miner fee)',
    (await mock.getRvnBalance(agentA)) === (BigInt(ONE_MILLION_RVN) - BigInt(ISSUE_FEE_PLUS_MINER)).toString() &&
    (await mock.getRvnBalance(agentB)) === ONE_MILLION_RVN &&
    (await mock.getRvnBalance()) === ((3_000_000n * RVN_BASE_UNITS_PER_COIN) - BigInt(ISSUE_FEE_PLUS_MINER)).toString(),
    { a: await mock.getRvnBalance(agentA), b: await mock.getRvnBalance(agentB), total: await mock.getRvnBalance() });

  await mock.transferAsset('ISOLCOIN', '40', agentB, agentA);
  check('mock transfer miner fee (3,500 sat) debits only the fromAddress',
    (await mock.getRvnBalance(agentA)) === (BigInt(ONE_MILLION_RVN) - BigInt(ISSUE_FEE_PLUS_MINER) - 3_500n).toString() &&
    (await mock.getRvnBalance(agentB)) === ONE_MILLION_RVN,
    { a: await mock.getRvnBalance(agentA), b: await mock.getRvnBalance(agentB) });

  const scoped = await mock.listWalletBalances(agentB);
  check('mock listWalletBalances(address) reports that agent RVN with the wallet-wide asset list',
    scoped.rvnBaseUnits === ONE_MILLION_RVN &&
    scoped.assets.length === 1 && scoped.assets[0]?.name === 'ISOLCOIN' &&
    scoped.assets[0]?.balanceBaseUnits === '100',
    scoped);

  // A low-RVN mock: an agent address seeded with 100 RVN cannot pay a
  // 500 RVN issue fee, and the failure names the balance.
  process.env.MOCK_RVN_BALANCE_BASE_UNITS = '10000000000'; // 100 RVN
  const poorMock = new MockRvnNode();
  const poorAgent = await poorMock.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}poor-agent`);
  let issueThrew = '';
  try {
    await poorMock.issueAsset({ name: 'POORCOIN', qty: '10', toAddress: throwaway, fromAddress: poorAgent });
  } catch (err) {
    issueThrew = err instanceof Error ? err.message : String(err);
  }
  check('mock issue from a 100 RVN agent address throws insufficient RVN',
    /insufficient RVN balance for issue fee \(needs 50000005000, wallet holds 10000000000\)/.test(issueThrew), issueThrew);
  check('mock failed issue charges no fee',
    (await poorMock.getRvnBalance(poorAgent)) === '10000000000');
  delete process.env.MOCK_RVN_BALANCE_BASE_UNITS;

  // ================= wallets module units =================
  const store = new MemoryStore();
  const seenLabels: string[] = [];
  const fakeNode = {
    getNewAddress: async (label?: string): Promise<string> => {
      seenLabels.push(label ?? '');
      return `mtest1fake${String(seenLabels.length).padStart(6, '0')}xxxxxxxxxxxx`;
    },
  } as unknown as RvnNode;
  const addr1 = await getOrCreateWalletAddress(store, fakeNode, 'agent-1');
  const addr1Again = await getOrCreateWalletAddress(store, fakeNode, 'agent-1');
  const addr2 = await getOrCreateWalletAddress(store, fakeNode, 'agent-2');
  check('getOrCreate is stable per agent and distinct across agents',
    addr1 === addr1Again && addr1 !== addr2 && addr1.length > 0, { addr1, addr1Again, addr2 });
  check('getOrCreate labels the node address rvn-agent-api:<agentId>',
    seenLabels[0] === 'rvn-agent-api:agent-1' && seenLabels[1] === 'rvn-agent-api:agent-2', seenLabels);
  check('getWalletAddress reads without provisioning',
    (await getWalletAddress(store, 'agent-1')) === addr1 &&
    (await getWalletAddress(store, 'agent-3')) === undefined);
  let threw = false;
  try {
    await getOrCreateWalletAddress(store, fakeNode, '   ');
  } catch {
    threw = true;
  }
  check('getOrCreate rejects a blank agentId', threw);
  threw = false;
  try {
    await getWalletAddress(store, '');
  } catch {
    threw = true;
  }
  check('getWalletAddress rejects a blank agentId', threw);
  const emptyNode = { getNewAddress: async (): Promise<string> => '' } as unknown as RvnNode;
  threw = false;
  try {
    await getOrCreateWalletAddress(new MemoryStore(), emptyNode, 'agent-9');
  } catch {
    threw = true;
  }
  check('getOrCreate throws when the node returns no address', threw);
  const failingStore = new MemoryStore();
  const origSet = failingStore.wallets.set.bind(failingStore.wallets);
  let setCalls = 0;
  failingStore.wallets.set = async (agentId: string, address: string): Promise<void> => {
    setCalls++;
    if (setCalls === 1) throw new Error('store down');
    return origSet(agentId, address);
  };
  threw = false;
  try {
    await getOrCreateWalletAddress(failingStore, fakeNode, 'agent-4');
  } catch {
    threw = true;
  }
  check('getOrCreate throws when the store cannot record the address (nothing half-provisioned)',
    threw && (await getWalletAddress(failingStore, 'agent-4')) === undefined);
  const retryAddr = await getOrCreateWalletAddress(failingStore, fakeNode, 'agent-4');
  check('a failed provision retries cleanly on the next call',
    typeof retryAddr === 'string' && retryAddr.length > 0 &&
    (await getWalletAddress(failingStore, 'agent-4')) === retryAddr);

  // ================= real-client units (stubbed fetch) =================
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: unknown[] };
      let result: unknown;
      if (body.method === 'listunspent') {
        // Only the requested address's UTXOs come back.
        const addrs = body.params[2] as string[];
        result = addrs?.includes('mtest1agent000001xxxxxxxxxxxx')
          ? [{ amount: 100.5 }, { amount: 0.25 }]
          : [];
      } else if (body.method === 'listassetbalancesbyaddress') {
        result = { FOO: 12.5, ZERO: 0 };
      } else if (body.method === 'getassetdata') {
        result = { name: 'FOO', amount: 12.5, units: 2, reissuable: 1 };
      } else if (body.method === 'getbalance') {
        result = 250.5;
      } else {
        throw new Error(`unexpected RPC ${body.method}`);
      }
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' });
    check('real client getRvnBalance(address) sums that address UTXOs (100.75 RVN)',
      (await client.getRvnBalance('mtest1agent000001xxxxxxxxxxxx')) === '10075000000',
      await client.getRvnBalance('mtest1agent000001xxxxxxxxxxxx'));
    check('real client getRvnBalance(address) is 0 for an address with no UTXOs',
      (await client.getRvnBalance('mtest1empty000001xxxxxxxxxxxx')) === '0');
    check('real client getRvnBalance() still reads the wallet-wide getbalance',
      (await client.getRvnBalance()) === '25050000000');
    const perAgent = await client.listWalletBalances('mtest1agent000001xxxxxxxxxxxx');
    check('real client listWalletBalances(address): address RVN + per-address assets, zero skipped',
      perAgent.rvnBaseUnits === '10075000000' &&
      perAgent.assets.length === 1 &&
      perAgent.assets[0]?.name === 'FOO' &&
      perAgent.assets[0]?.balanceBaseUnits === '1250' &&
      perAgent.assets[0]?.units === 2,
      perAgent);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ================= booted-API integration =================
  let child1: ChildProcess | undefined;
  let child2: ChildProcess | undefined;
  let child3: ChildProcess | undefined;
  try {
    child1 = await bootApi(API1_PORT);

    const a1 = await req(API1, 'GET', '/v1/wallet/address/agent-1');
    const a1Again = await req(API1, 'GET', '/v1/wallet/address/agent-1');
    const a2 = await req(API1, 'GET', '/v1/wallet/address/agent-2');
    check('API wallet address is stable per agent and distinct across agents',
      a1.status === 200 && a1.json?.agentId === 'agent-1' &&
      typeof a1.json?.address === 'string' && a1.json.address.length > 0 &&
      a1Again.json?.address === a1.json.address &&
      a2.json?.address !== a1.json.address,
      { a1: a1.json, a1Again: a1Again.json, a2: a2.json });
    const address1 = a1.json.address as string;
    const address2 = a2.json.address as string;

    // Simulate must not provision: a fresh agent's simulate leaves the
    // wallet-wide total at the operator seed, and the address route
    // afterwards provisions exactly once.
    const wideBefore = await req(API1, 'GET', '/v1/wallet/balances');
    const sim = await req(API1, 'POST', '/v1/intents/simulate', {
      op: 'issue', agentId: 'agent-3', name: 'SIMCOIN', qty: '100', toAddress: address1,
    });
    const wideAfterSim = await req(API1, 'GET', '/v1/wallet/balances');
    check('simulate does not provision an address (wallet-wide total unmoved)',
      sim.status === 200 &&
      wideBefore.json?.rvnBaseUnits === (3_000_000n * RVN_BASE_UNITS_PER_COIN).toString() &&
      wideAfterSim.json?.rvnBaseUnits === (3_000_000n * RVN_BASE_UNITS_PER_COIN).toString(),
      { before: wideBefore.json, after: wideAfterSim.json });
    const a3 = await req(API1, 'GET', '/v1/wallet/address/agent-3');
    const wideAfterProvision = await req(API1, 'GET', '/v1/wallet/balances');
    check('provisioning agent-3 afterwards adds exactly one 1,000,000 RVN seed to the total',
      a3.status === 200 && typeof a3.json?.address === 'string' &&
      wideAfterProvision.json?.rvnBaseUnits === (4_000_000n * RVN_BASE_UNITS_PER_COIN).toString(),
      wideAfterProvision.json);

    // Per-agent balances: allowlist each agent's own address, issue twice
    // as agent-1, and prove only agent-1's RVN moved.
    for (const [agent, address] of [['agent-1', address1], ['agent-2', address2]] as const) {
      const basePolicy = await req(API1, 'GET', `/v1/policies/${agent}`);
      const putPolicy = await req(API1, 'PUT', `/v1/policies/${agent}`, {
        ...basePolicy.json, agentId: agent, allowedDestinations: [address],
      });
      if (putPolicy.status !== 200) throw new Error(`policy PUT for ${agent} failed: ${JSON.stringify(putPolicy.json)}`);
    }
    const issue1 = await req(API1, 'POST', '/v1/assets/issue', { agentId: 'agent-1', name: 'AGT1COIN', qty: '500', toAddress: address1 });
    const issue2 = await req(API1, 'POST', '/v1/assets/issue', { agentId: 'agent-1', name: 'AGT1COIN2', qty: '7', toAddress: address1 });
    check('API issues ALLOW for agent-1', issue1.status === 200 && issue2.status === 200, { issue1: issue1.json, issue2: issue2.json });
    const bal1 = await req(API1, 'GET', '/v1/wallet/balances?agentId=agent-1');
    const bal2 = await req(API1, 'GET', '/v1/wallet/balances?agentId=agent-2');
    const balWide = await req(API1, 'GET', '/v1/wallet/balances');
    const expectedAgent1 = ((999_000n * RVN_BASE_UNITS_PER_COIN) - 10_000n).toString();
    check('API per-agent balances: two issues debit only agent-1 (999,000 RVN - 10,000 sat), agent-2 untouched at 1,000,000 RVN',
      bal1.json?.rvnBaseUnits === expectedAgent1 &&
      bal2.json?.rvnBaseUnits === ONE_MILLION_RVN,
      { bal1: bal1.json, bal2: bal2.json });
    check('API wallet-wide total is the sum (operator + agent-1 + agent-2 + agent-3)',
      balWide.json?.rvnBaseUnits === ((3_999_000n * RVN_BASE_UNITS_PER_COIN) - 10_000n).toString() &&
      balWide.json?.assets?.length === 2,
      balWide.json);

    // ================= funding isolation on a 600 RVN mock =================
    child3 = await bootApi(API3_PORT, { MOCK_RVN_BALANCE_BASE_UNITS: '60000000000' }); // 600 RVN
    const low3a = await req(API3, 'GET', '/v1/wallet/address/agent-1');
    const low3b = await req(API3, 'GET', '/v1/wallet/address/agent-2');
    const lowAddr1 = low3a.json.address as string;
    const lowAddr2 = low3b.json.address as string;
    for (const [agent, address] of [['agent-1', lowAddr1], ['agent-2', lowAddr2]] as const) {
      const basePolicy = await req(API3, 'GET', `/v1/policies/${agent}`);
      await req(API3, 'PUT', `/v1/policies/${agent}`, {
        ...basePolicy.json, agentId: agent, allowedDestinations: [address],
      });
    }
    const drain = await req(API3, 'POST', '/v1/assets/issue', { agentId: 'agent-1', name: 'DRAINCOIN', qty: '10', toAddress: lowAddr1 });
    check('low-RVN API: agent-1 first issue ALLOWs (600 RVN covers 500 RVN + miner fee)',
      drain.status === 200 && drain.json?.decision?.kind === 'ALLOW', drain.json);
    const second = await req(API3, 'POST', '/v1/assets/issue', { agentId: 'agent-1', name: 'DRAINCOIN2', qty: '10', toAddress: lowAddr1 });
    check('low-RVN API: agent-1 second issue DENYs on its own drained balance (99.99995 RVN left)',
      second.status === 403 && second.json?.decision?.kind === 'DENY' &&
      second.json?.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE') &&
      second.json?.funding?.balanceBaseUnits === '9999995000',
      second.json);
    const other = await req(API3, 'POST', '/v1/assets/issue', { agentId: 'agent-2', name: 'OTHERCOIN', qty: '10', toAddress: lowAddr2 });
    check('low-RVN API: agent-2 still ALLOWs — its own 600 RVN is untouched by agent-1',
      other.status === 200 && other.json?.decision?.kind === 'ALLOW', other.json);
    const lowSim = await req(API3, 'POST', '/v1/intents/simulate', {
      op: 'issue', agentId: 'agent-1', name: 'SIMDRAIN', qty: '10', toAddress: lowAddr1,
    });
    check('low-RVN API: simulate for the drained agent reports the per-agent DENY with its balance',
      lowSim.json?.decision?.kind === 'DENY' &&
      lowSim.json?.funding?.balanceBaseUnits === '9999995000' &&
      lowSim.json?.funding?.requiredBaseUnits === '50000005000',
      lowSim.json);

    // ================= auth-on leg =================
    child2 = await bootApi(API2_PORT, {
      RVN_AUTH_ENABLED: 'true',
      RVN_OPERATOR_API_KEY: OPERATOR_KEY,
    });
    const keyless = await req(API2, 'GET', '/v1/wallet/address/agent-1');
    check('auth-on: keyless address read 401s', keyless.status === 401, keyless);
    const key1 = await req(API2, 'POST', '/v1/admin/api-keys', { agentId: 'agent-1' }, OPERATOR_KEY);
    const agentKey = key1.json?.key as string;
    const own = await req(API2, 'GET', '/v1/wallet/address/agent-1', undefined, agentKey);
    check('auth-on: per-agent key reads its own address', own.status === 200 && typeof own.json?.address === 'string', own);
    const otherAddr = await req(API2, 'GET', '/v1/wallet/address/agent-2', undefined, agentKey);
    check('auth-on: per-agent key 403s on another agent address', otherAddr.status === 403, otherAddr);
    const ownBal = await req(API2, 'GET', '/v1/wallet/balances?agentId=agent-1', undefined, agentKey);
    check('auth-on: per-agent key reads its own balances', ownBal.status === 200 && ownBal.json?.rvnBaseUnits === ONE_MILLION_RVN, ownBal);
    const otherBal = await req(API2, 'GET', '/v1/wallet/balances?agentId=agent-2', undefined, agentKey);
    check('auth-on: per-agent key 403s on another agent balances', otherBal.status === 403, otherBal);
    const opAddr = await req(API2, 'GET', '/v1/wallet/address/agent-9', undefined, OPERATOR_KEY);
    check('auth-on: operator key reads any agent address', opAddr.status === 200 && typeof opAddr.json?.address === 'string', opAddr);
  } finally {
    child1?.kill('SIGTERM');
    child2?.kill('SIGTERM');
    child3?.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nper-agent wallets: all checks passed');
}

await main();
