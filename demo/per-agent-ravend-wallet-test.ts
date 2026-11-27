/**
 * per-agent-ravend-wallet-test: checks for per-agent ravend wallets
 * (v0.43.0, slice 3 of per-agent wallets — the item is complete with
 * this slice).
 *
 *  pnpm test:agent-wallets
 *
 * Units: the wallets module (agentWalletName sanitization, the
 * getOrCreate list -> load -> create provisioning incl. the create-race
 * re-check, the read-only getAgentWallet that never provisions), the
 * mock node's multi-wallet state (create/load/list, per-wallet RVN and
 * asset isolation, the chain-global asset registry, unloaded-wallet
 * refusal, per-wallet seeding), and the real client's wallet routing
 * against a stubbed fetch (management RPCs on the base URL, wallet
 * RPCs on /wallet/<name>, node-level and registry RPCs on the base URL
 * even when scoped).
 *
 * Integration: boots the real API as a child process (MOCK_RVN=true)
 * and asserts:
 *   - /v1/health reports wallets.perAgent
 *   - an agent issues inside its own wallet: its scoped balances show
 *     the coin, a second agent's scoped balances show none of it, and
 *     the default (operator) wallet-wide read shows no coin and its
 *     1,000,000 RVN seed untouched — while GET /v1/assets still lists
 *     the coin (the registry is chain-global)
 *   - a second agent cannot transfer the first agent's coin: the submit
 *     is refused by the funding gate (403 DENY
 *     INSUFFICIENT_ASSET_BALANCE, null balance), simulate agrees with
 *     zero side effects, and a held transfer by the second agent is
 *     refused at approval time (403, hold ends, nothing moves)
 *   - funding isolation on a 600 RVN mock: agent-1 drains its own
 *     wallet and then DENYs while agent-2 still ALLOWs, and simulate
 *     for the drained agent reads its own wallet balance
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import { RvnRpcClient } from '../src/rvn/client.js';
import {
  AGENT_WALLET_LABEL_PREFIX,
  agentWalletName,
  getAgentWallet,
  getOrCreateAgentWallet,
} from '../src/rvn/wallets.js';
import type { RvnNode } from '../src/rvn/types.js';
import { RVN_BASE_UNITS_PER_COIN } from '../src/policy/funding.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3140;
const LOW_PORT = 3141;
const API = `http://127.0.0.1:${API_PORT}`;
const LOW_API = `http://127.0.0.1:${LOW_PORT}`;
const ONE_MILLION_RVN = (1_000_000n * RVN_BASE_UNITS_PER_COIN).toString();
const STRANGER = 'mtest1stranger000001xxxxxxxxxxxx';

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

async function req(api: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
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

async function main(): Promise<void> {
  // ================= wallets module units =================
  check('agentWalletName derives rvn-agent-api-<agentId>',
    agentWalletName('agent-1') === 'rvn-agent-api-agent-1');
  check('agentWalletName sanitizes unsafe characters to dashes',
    agentWalletName('Agent One!') === 'rvn-agent-api-Agent-One-' &&
    agentWalletName('a/b') === 'rvn-agent-api-a-b' &&
    agentWalletName('/') === 'rvn-agent-api--');
  for (const bad of ['', '   ', '.', '..']) {
    let threw = false;
    try {
      agentWalletName(bad);
    } catch {
      threw = true;
    }
    check(`agentWalletName rejects ${JSON.stringify(bad)}`, threw);
  }

  const mock = new MockRvnNode();
  const created = await getOrCreateAgentWallet(mock, 'agent-a');
  check('getOrCreateAgentWallet provisions and returns a scoped node',
    created.walletName === 'rvn-agent-api-agent-a' &&
    (await created.getRvnBalance()) === ONE_MILLION_RVN,
    { walletName: created.walletName });
  const again = await getOrCreateAgentWallet(mock, 'agent-a');
  check('getOrCreateAgentWallet reuses the loaded wallet on a second call',
    again.walletName === 'rvn-agent-api-agent-a' &&
    (await mock.listWallets()).filter((w) => w === 'rvn-agent-api-agent-a').length === 1);
  let threw = false;
  try {
    await getOrCreateAgentWallet(mock, '');
  } catch {
    threw = true;
  }
  check('getOrCreateAgentWallet rejects an empty agent id', threw);

  // Load path: a node whose list omits the wallet but whose load
  // succeeds (a wallet file that exists but is not loaded, e.g. after
  // a node restart) is loaded, not created.
  const base = new MockRvnNode();
  let listed: string[] = [];
  let createdViaStub = false;
  const loadStub = {
    listWallets: async () => listed,
    loadWallet: async (name: string) => {
      listed.push(name);
    },
    createWallet: async () => {
      createdViaStub = true;
    },
    withWallet: (name: string) => base.withWallet(name),
  } as unknown as RvnNode;
  const loaded = await getOrCreateAgentWallet(loadStub, 'agent-load');
  check('getOrCreateAgentWallet loads an existing-but-unloaded wallet instead of creating it',
    loaded.walletName === 'rvn-agent-api-agent-load' && !createdViaStub);
  // Create path: load throws (no wallet file), so create runs.
  const listed2: string[] = [];
  const createStub = {
    listWallets: async () => listed2,
    loadWallet: async () => {
      throw new Error('wallet not found');
    },
    createWallet: async (name: string) => {
      await base.createWallet(name);
      listed2.push(name);
    },
    withWallet: (name: string) => base.withWallet(name),
  } as unknown as RvnNode;
  const created2 = await getOrCreateAgentWallet(createStub, 'agent-create');
  check('getOrCreateAgentWallet creates when load fails, and the wallet is usable',
    created2.walletName === 'rvn-agent-api-agent-create' &&
    (await created2.getRvnBalance()) === ONE_MILLION_RVN);
  // Create race: create throws "already exists" but the wallet is
  // listed on re-check, so provisioning still succeeds.
  const raceStub = {
    listWallets: async () => ['rvn-agent-api-agent-race'],
    loadWallet: async () => {
      throw new Error('wallet not found');
    },
    createWallet: async () => {
      throw new Error('wallet rvn-agent-api-agent-race already exists');
    },
    withWallet: (name: string) => base.withWallet(name),
  } as unknown as RvnNode;
  const raced = await getOrCreateAgentWallet(raceStub, 'agent-race');
  check('getOrCreateAgentWallet survives a create race (already exists + listed)',
    raced.walletName === 'rvn-agent-api-agent-race');
  // A node without the wallet seam degrades loudly (the server catches
  // this and falls back to the shared wallet).
  const noSeam = { getRvnBalance: async () => '0' } as unknown as RvnNode;
  let seamThrew = false;
  try {
    await getOrCreateAgentWallet(noSeam, 'agent-a');
  } catch {
    seamThrew = true;
  }
  check('getOrCreateAgentWallet throws on a node without wallet support', seamThrew);

  // Read-only path: never provisions.
  const readMock = new MockRvnNode();
  const beforeRead = await readMock.listWallets();
  const readBase = await getAgentWallet(readMock, 'agent-new');
  check('getAgentWallet returns the base node for an agent with no wallet',
    readBase === readMock && (await readMock.listWallets()).length === beforeRead.length);
  await getOrCreateAgentWallet(readMock, 'agent-new');
  const readScoped = await getAgentWallet(readMock, 'agent-new');
  check('getAgentWallet returns the scoped node once the wallet exists',
    readScoped !== readMock && readScoped.walletName === 'rvn-agent-api-agent-new');
  check('getAgentWallet never provisions (wallet count unchanged by reads)',
    (await readMock.listWallets()).length === beforeRead.length + 1);

  // ================= mock multi-wallet units =================
  const m = new MockRvnNode();
  check('mock listWallets starts with only the default wallet',
    JSON.stringify(await m.listWallets()) === JSON.stringify(['']));
  await m.createWallet('w1');
  await m.createWallet('w2');
  check('mock createWallet lists the new wallets alongside the default',
    JSON.stringify((await m.listWallets()).sort()) === JSON.stringify(['', 'w1', 'w2']));
  let dupThrew = false;
  try {
    await m.createWallet('w1');
  } catch {
    dupThrew = true;
  }
  check('mock createWallet throws when the wallet already exists', dupThrew);
  for (const badName of ['', '  ', 'a/b', 'a\\b']) {
    let badThrew = false;
    try {
      await m.createWallet(badName);
    } catch {
      badThrew = true;
    }
    check(`mock createWallet rejects ${JSON.stringify(badName)}`, badThrew);
  }
  let loadThrew = false;
  try {
    await m.loadWallet('nope');
  } catch {
    loadThrew = true;
  }
  check('mock loadWallet throws for a wallet that was never created', loadThrew);
  await m.loadWallet('w1');
  check('mock loadWallet succeeds for a created wallet', true);
  let unloadedThrew = false;
  try {
    await m.withWallet('never-created').getRvnBalance();
  } catch {
    unloadedThrew = true;
  }
  check('mock withWallet on an uncreated wallet throws on use', unloadedThrew);

  const wa = m.withWallet('w1');
  const wb = m.withWallet('w2');
  const addrA = await wa.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-a`);
  const addrB = await wb.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-b`);
  await wa.issueAsset({ name: 'WALLETCOIN', qty: '100', toAddress: addrA, fromAddress: addrA });
  check('mock issue in wallet w1 is invisible to w2 and to the default wallet',
    (await wa.getAssetBalance('WALLETCOIN')) === '100' &&
    (await wb.getAssetBalance('WALLETCOIN')) === null &&
    (await m.getAssetBalance('WALLETCOIN')) === null &&
    (await wb.listWalletBalances()).assets.length === 0 &&
    (await m.listWalletBalances()).assets.length === 0,
    {
      w1: await wa.getAssetBalance('WALLETCOIN'),
      w2: await wb.getAssetBalance('WALLETCOIN'),
      def: await m.getAssetBalance('WALLETCOIN'),
    });
  check('mock asset registry is chain-global: listAssets sees the coin from any wallet',
    (await wb.listAssets()).some((a) => a.name === 'WALLETCOIN') &&
    (await m.listAssets()).some((a) => a.name === 'WALLETCOIN') &&
    (await wb.getAssetData('WALLETCOIN'))?.amount === '100');
  let sameNameThrew = false;
  try {
    await wb.issueAsset({ name: 'WALLETCOIN', qty: '1', toAddress: addrB, fromAddress: addrB });
  } catch {
    sameNameThrew = true;
  }
  check('mock cannot issue the same asset name in a second wallet (chain-global registry)', sameNameThrew);
  await wb.issueAsset({ name: 'WBCOIN', qty: '50', toAddress: addrB, fromAddress: addrB });
  let crossThrew = false;
  try {
    await wa.transferAsset('WBCOIN', '10', addrA, addrA);
  } catch {
    crossThrew = true;
  }
  check('mock transfer in w1 cannot spend w2\'s asset (fromAddress debit)', crossThrew);
  let crossNoFromThrew = false;
  try {
    await wa.transferAsset('WBCOIN', '10', addrA);
  } catch {
    crossNoFromThrew = true;
  }
  check('mock transfer in w1 cannot spend w2\'s asset (no-fromAddress debit either)', crossNoFromThrew);
  check('mock RVN is per-wallet: w1 total is its seeds minus the issue fee, w2 and default untouched',
    (await wa.getRvnBalance()) === ((2_000_000n * RVN_BASE_UNITS_PER_COIN) - 500n * RVN_BASE_UNITS_PER_COIN - 5_000n).toString() &&
    (await wb.getRvnBalance()) === ((2_000_000n * RVN_BASE_UNITS_PER_COIN) - 500n * RVN_BASE_UNITS_PER_COIN - 5_000n).toString() &&
    (await m.getRvnBalance()) === ONE_MILLION_RVN,
    {
      w1: await wa.getRvnBalance(),
      w2: await wb.getRvnBalance(),
      def: await m.getRvnBalance(),
    });
  const wbBalances = await wb.listWalletBalances();
  check('mock listWalletBalances in w2 lists only w2\'s assets',
    wbBalances.assets.length === 1 && wbBalances.assets[0]?.name === 'WBCOIN' &&
    wbBalances.assets[0]?.balanceBaseUnits === '50');

  // Drain isolation on a low-RVN mock: one wallet's drain cannot touch
  // another wallet's balance.
  const prevEnv = process.env.MOCK_RVN_BALANCE_BASE_UNITS;
  process.env.MOCK_RVN_BALANCE_BASE_UNITS = '60000000000'; // 600 RVN
  const low = new MockRvnNode();
  await low.createWallet('low1');
  await low.createWallet('low2');
  const low1 = low.withWallet('low1');
  const low2 = low.withWallet('low2');
  const lowAddr1 = await low1.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-1`);
  const lowAddr2 = await low2.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-2`);
  await low1.issueAsset({ name: 'DRAINCOIN', qty: '10', toAddress: lowAddr1, fromAddress: lowAddr1 });
  check('low-RVN mock: first issue in low1 leaves its agent address at 99.99995 RVN',
    (await low1.getRvnBalance(lowAddr1)) === '9999995000');
  let lowDenyThrew = false;
  try {
    await low1.issueAsset({ name: 'DRAINCOIN2', qty: '10', toAddress: lowAddr1, fromAddress: lowAddr1 });
  } catch {
    lowDenyThrew = true;
  }
  check('low-RVN mock: second issue in the drained wallet throws (insufficient RVN)', lowDenyThrew);
  const lowOther = await low2.issueAsset({ name: 'OTHERCOIN', qty: '10', toAddress: lowAddr2, fromAddress: lowAddr2 });
  check('low-RVN mock: the other wallet still issues (its 600 RVN untouched)',
    typeof lowOther === 'string' && lowOther.startsWith('mock-txid-'));
  if (prevEnv === undefined) delete process.env.MOCK_RVN_BALANCE_BASE_UNITS;
  else process.env.MOCK_RVN_BALANCE_BASE_UNITS = prevEnv;

  // ================= real-client stubbed-fetch units =================
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; params: unknown[] }> = [];
  try {
    globalThis.fetch = (async (url: any, init?: any) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params?: unknown[] };
      calls.push({ url: String(url), method: body.method, params: body.params ?? [] });
      let result: unknown = null;
      switch (body.method) {
        case 'createwallet':
        case 'loadwallet':
          result = { name: body.params?.[0], warning: null };
          break;
        case 'listwallets':
          result = ['', 'w1'];
          break;
        case 'getbalance':
          result = 100000000;
          break;
        case 'getblockchaininfo':
          result = { chain: 'test', blocks: 5, connections: 0 };
          break;
        case 'issue':
          result = 'txid-stub';
          break;
        case 'listassets':
          result = {};
          break;
        case 'listassetbalancesbyaddress':
          result = { FOO: 2 };
          break;
        case 'getassetdata':
          result = { name: 'FOO', amount: 2, units: 0, reissuable: 1 };
          break;
        default:
          result = null;
      }
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new RvnRpcClient({ url: 'http://127.0.0.1:9', user: 'u', pass: 'p' });
    calls.length = 0;
    await client.createWallet('w1');
    check('real client: createWallet calls createwallet on the base URL',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9' &&
      calls[0]?.method === 'createwallet' && JSON.stringify(calls[0]?.params) === JSON.stringify(['w1']),
      calls);
    calls.length = 0;
    await client.loadWallet('w1');
    check('real client: loadWallet calls loadwallet on the base URL',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9' && calls[0]?.method === 'loadwallet',
      calls);
    calls.length = 0;
    const wallets = await client.listWallets();
    check('real client: listWallets calls listwallets on the base URL',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9' && calls[0]?.method === 'listwallets' &&
      JSON.stringify(wallets) === JSON.stringify(['', 'w1']),
      calls);
    const scoped = client.withWallet('w 1');
    check('real client: withWallet reports the wallet name', scoped.walletName === 'w 1');
    calls.length = 0;
    const scopedBalance = await scoped.getRvnBalance();
    check('real client: a scoped balance read goes to /wallet/<name> (URL-encoded)',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9/wallet/w%201' &&
      calls[0]?.method === 'getbalance' && scopedBalance === '10000000000000000',
      calls);
    calls.length = 0;
    const scopedInfo = await scoped.getInfo();
    check('real client: chain info stays on the base URL even when scoped',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9' &&
      calls[0]?.method === 'getblockchaininfo' && scopedInfo.chain === 'test',
      calls);
    calls.length = 0;
    const scopedTxid = await scoped.issueAsset({ name: 'FOO', qty: '1', toAddress: 'addr' });
    check('real client: a scoped issue goes to /wallet/<name>',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9/wallet/w%201' &&
      calls[0]?.method === 'issue' && scopedTxid === 'txid-stub',
      calls);
    calls.length = 0;
    await scoped.listAssets();
    check('real client: listassets stays on the base URL even when scoped (global registry)',
      calls.length === 1 && calls[0]?.url === 'http://127.0.0.1:9' && calls[0]?.method === 'listassets',
      calls);
    calls.length = 0;
    const scopedAsset = await scoped.getAssetBalance('FOO', 'addr');
    check('real client: a scoped per-address asset read goes to /wallet/<name> (units via getassetdata on the base URL)',
      calls.length === 2 &&
      calls[0]?.url === 'http://127.0.0.1:9/wallet/w%201' &&
      calls[0]?.method === 'listassetbalancesbyaddress' &&
      calls[1]?.url === 'http://127.0.0.1:9' && calls[1]?.method === 'getassetdata' &&
      scopedAsset === '2',
      calls);
    check('real client: the default client has no wallet name', client.walletName === undefined);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ================= booted-API integration =================
  let child1: ChildProcess | undefined;
  let child2: ChildProcess | undefined;
  try {
    child1 = await bootApi(API_PORT);
    const health = await req(API, 'GET', '/v1/health');
    check('API health reports per-agent wallets',
      health.json?.ok === true && health.json?.wallets?.perAgent === true, health.json?.wallets);

    const addr1 = (await req(API, 'GET', '/v1/wallet/address/agent-1')).json?.address as string;
    check('agent-1 wallet address provisioned', typeof addr1 === 'string' && addr1.length > 0, addr1);
    const dest = (await req(API, 'POST', '/v1/wallets', {})).json?.address as string;
    check('destination wallet provisioned', typeof dest === 'string' && dest.length > 0, dest);
    const base1 = await req(API, 'GET', '/v1/policies/agent-1');
    const put1 = await req(API, 'PUT', '/v1/policies/agent-1', {
      ...base1.json, agentId: 'agent-1', allowedDestinations: [addr1, dest],
    });
    check('agent-1 policy allowlists its own wallet and the destination', put1.status === 200, put1.json);

    const issue = await req(API, 'POST', '/v1/assets/issue', {
      agentId: 'agent-1', name: 'WALLETCOIN', qty: '500', toAddress: addr1,
    });
    check('agent-1 issues 500 WALLETCOIN to its own wallet address (ALLOW)',
      issue.status === 200 && issue.json?.decision?.kind === 'ALLOW' && typeof issue.json?.txid === 'string', issue.json);

    const assets = await req(API, 'GET', '/v1/assets');
    check('GET /v1/assets still lists the coin (the registry is chain-global)',
      assets.status === 200 && (assets.json?.assets ?? []).some((a: any) => a.name === 'WALLETCOIN'),
      assets.json?.assets);

    const agent1Balances = await req(API, 'GET', '/v1/wallet/balances?agentId=agent-1');
    check('agent-1 scoped balances show the coin and its own debited RVN',
      agent1Balances.status === 200 &&
      agent1Balances.json?.assets?.length === 1 &&
      agent1Balances.json.assets[0]?.name === 'WALLETCOIN' &&
      agent1Balances.json.assets[0]?.balanceBaseUnits === '500' &&
      agent1Balances.json?.rvnBaseUnits === (BigInt(ONE_MILLION_RVN) - 500n * RVN_BASE_UNITS_PER_COIN - 5_000n).toString(),
      agent1Balances.json);
    const agent2Balances = await req(API, 'GET', '/v1/wallet/balances?agentId=agent-2');
    check('agent-2 scoped balances list no WALLETCOIN (its wallet never held it)',
      agent2Balances.status === 200 &&
      Array.isArray(agent2Balances.json?.assets) &&
      !agent2Balances.json.assets.some((a: any) => a.name === 'WALLETCOIN') &&
      agent2Balances.json?.rvnBaseUnits === ONE_MILLION_RVN,
      agent2Balances.json);
    const wideBalances = await req(API, 'GET', '/v1/wallet/balances');
    check('default wallet-wide read is the operator wallet only: 1,000,000 RVN, no WALLETCOIN',
      wideBalances.status === 200 &&
      wideBalances.json?.rvnBaseUnits === ONE_MILLION_RVN &&
      Array.isArray(wideBalances.json?.assets) &&
      !wideBalances.json.assets.some((a: any) => a.name === 'WALLETCOIN'),
      wideBalances.json);

    // Agent-2 cannot transfer agent-1's coin: its wallet never held it.
    const base2 = await req(API, 'GET', '/v1/policies/agent-2');
    const put2 = await req(API, 'PUT', '/v1/policies/agent-2', {
      ...base2.json, agentId: 'agent-2', allowedDestinations: [dest],
    });
    check('agent-2 policy allowlists the destination', put2.status === 200, put2.json);
    const auditBefore = await req(API, 'GET', '/v1/audit?limit=1');
    const seqBefore = auditBefore.json?.entries?.[0]?.seq ?? 0;
    const denied = await req(API, 'POST', '/v1/assets/transfer', {
      agentId: 'agent-2', assetName: 'WALLETCOIN', qty: '100', destination: dest,
    });
    check("agent-2 cannot transfer agent-1's coin: 403 DENY INSUFFICIENT_ASSET_BALANCE",
      denied.status === 403 && denied.json?.decision?.kind === 'DENY' &&
      denied.json?.decision?.reasonCodes?.length === 1 &&
      denied.json?.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE'),
      denied.json);
    check('agent-2 funding object carries the null balance (its wallet holds none)',
      denied.json?.funding?.asset === 'WALLETCOIN' &&
      denied.json?.funding?.requiredBaseUnits === '100' &&
      denied.json?.funding?.balanceBaseUnits === null &&
      denied.json?.funding?.funded === false,
      denied.json?.funding);
    const auditAfterDenied = await req(API, 'GET', '/v1/audit?limit=1');
    check('the gated denial is audited as one DECISION entry',
      (auditAfterDenied.json?.entries?.[0]?.seq ?? 0) === seqBefore + 1,
      { before: seqBefore, after: auditAfterDenied.json?.entries?.[0]?.seq });

    const simDenied = await req(API, 'POST', '/v1/intents/simulate', {
      op: 'transfer', agentId: 'agent-2', assetName: 'WALLETCOIN', qty: '100', destination: dest,
    });
    check('simulate agrees for agent-2 (DENY, funding object, zero side effects)',
      simDenied.status === 200 && simDenied.json?.decision?.kind === 'DENY' &&
      simDenied.json?.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE') &&
      simDenied.json?.funding?.funded === false,
      simDenied.json);
    const auditAfterSim = await req(API, 'GET', '/v1/audit?limit=1');
    check('simulate wrote no audit entries',
      (auditAfterSim.json?.entries?.[0]?.seq ?? 0) === seqBefore + 1,
      { afterSim: auditAfterSim.json?.entries?.[0]?.seq });

    const simFunded = await req(API, 'POST', '/v1/intents/simulate', {
      op: 'transfer', agentId: 'agent-1', assetName: 'WALLETCOIN', qty: '100', destination: dest,
    });
    check('simulate for agent-1 still ALLOWs (its wallet holds 500)',
      simFunded.status === 200 && simFunded.json?.decision?.kind === 'ALLOW' &&
      simFunded.json?.funding?.funded === true &&
      simFunded.json?.funding?.balanceBaseUnits === '500',
      simFunded.json);

    // A held transfer by agent-2 is refused at approval time by the
    // same gate: the hold ends as a clean funding DENY, nothing moves.
    const held = await req(API, 'POST', '/v1/assets/transfer', {
      agentId: 'agent-2', assetName: 'WALLETCOIN', qty: '100', destination: STRANGER,
    });
    check('agent-2 transfer to an unknown destination holds (202)',
      held.status === 202 && held.json?.decision?.kind === 'REQUIRE_APPROVAL', held.json);
    const refused = await req(API, 'POST', `/v1/intents/${held.json.intent?.id}/approve`, { approver: 'paul' });
    check('approving the held transfer is refused by the funding gate (403)',
      refused.status === 403 && refused.json?.decision?.kind === 'DENY' &&
      refused.json?.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE') &&
      refused.json?.funding?.funded === false,
      refused.json);
    const reApprove = await req(API, 'POST', `/v1/intents/${held.json.intent?.id}/approve`, { approver: 'paul' });
    check('the refused hold is over (approve -> 409)', reApprove.status === 409, reApprove.json);
    const afterAll = await req(API, 'GET', '/v1/wallet/balances?agentId=agent-1');
    check('nothing moved: agent-1 still holds 500 WALLETCOIN',
      afterAll.json?.assets?.find((a: any) => a.name === 'WALLETCOIN')?.balanceBaseUnits === '500',
      afterAll.json?.assets);

    const audit = await req(API, 'GET', '/v1/audit?limit=100');
    check('audit chain valid', audit.json?.chainValid === true, audit.json);

    // ================= funding isolation on a 600 RVN mock =================
    child2 = await bootApi(LOW_PORT, { MOCK_RVN_BALANCE_BASE_UNITS: '60000000000' });
    const lowAddr1 = (await req(LOW_API, 'GET', '/v1/wallet/address/agent-1')).json?.address as string;
    const lowAddr2 = (await req(LOW_API, 'GET', '/v1/wallet/address/agent-2')).json?.address as string;
    for (const [agent, address] of [['agent-1', lowAddr1], ['agent-2', lowAddr2]] as const) {
      const basePolicy = await req(LOW_API, 'GET', `/v1/policies/${agent}`);
      await req(LOW_API, 'PUT', `/v1/policies/${agent}`, {
        ...basePolicy.json, agentId: agent, allowedDestinations: [address],
      });
    }
    const drain = await req(LOW_API, 'POST', '/v1/assets/issue', { agentId: 'agent-1', name: 'DRAINCOIN', qty: '10', toAddress: lowAddr1 });
    check('low-RVN API: agent-1 first issue ALLOWs (600 RVN covers 500 RVN + miner fee)',
      drain.status === 200 && drain.json?.decision?.kind === 'ALLOW', drain.json);
    const second = await req(LOW_API, 'POST', '/v1/assets/issue', { agentId: 'agent-1', name: 'DRAINCOIN2', qty: '10', toAddress: lowAddr1 });
    check('low-RVN API: agent-1 second issue DENYs on its own drained wallet (99.99995 RVN left)',
      second.status === 403 && second.json?.decision?.kind === 'DENY' &&
      second.json?.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE') &&
      second.json?.funding?.balanceBaseUnits === '9999995000',
      second.json);
    const other = await req(LOW_API, 'POST', '/v1/assets/issue', { agentId: 'agent-2', name: 'OTHERCOIN', qty: '10', toAddress: lowAddr2 });
    check('low-RVN API: agent-2 still ALLOWs — its own wallet\'s 600 RVN is untouched by agent-1',
      other.status === 200 && other.json?.decision?.kind === 'ALLOW', other.json);
    const lowSim = await req(LOW_API, 'POST', '/v1/intents/simulate', {
      op: 'issue', agentId: 'agent-1', name: 'SIMDRAIN', qty: '10', toAddress: lowAddr1,
    });
    check('low-RVN API: simulate for the drained agent reads its own wallet (DENY with its balance)',
      lowSim.json?.decision?.kind === 'DENY' &&
      lowSim.json?.funding?.balanceBaseUnits === '9999995000' &&
      lowSim.json?.funding?.requiredBaseUnits === '50000005000',
      lowSim.json);
  } finally {
    child1?.kill('SIGTERM');
    child2?.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nper-agent ravend wallets: all checks passed');
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
