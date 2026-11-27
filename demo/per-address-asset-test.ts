/**
 * per-address-asset-test: checks for per-address asset balances (v0.42.0,
 * slice 2 of per-agent wallets).
 *
 *  pnpm test:per-address-assets
 *
 * Units: the mock node's per-address asset balances (getAssetBalance and
 * listWalletBalances scoped to one address, wallet-wide reads unchanged),
 * the transfer debit (with a fromAddress only that address's holding
 * moves — an agent cannot transfer another agent's assets — while a
 * transfer without one keeps the old debit-from-wherever behavior), and
 * the real client's per-address read against a stubbed fetch
 * (listassetbalancesbyaddress + getassetdata for the units).
 *
 * Integration: boots the real API as a child process (MOCK_RVN=true)
 * and asserts:
 *   - an agent issues to its own wallet address, then transfers part of
 *     it onward: the transfer ALLOWs and executes, and the agent-scoped
 *     balances show only what that address still holds while the
 *     default wallet-wide list shows none of it (the coin lives in the
 *     agent's own ravend wallet since v0.43.0)
 *   - a second agent cannot transfer the first agent's asset: the submit
 *     is refused by the funding gate (403 DENY INSUFFICIENT_ASSET_BALANCE
 *     with a null balance), nothing moves, and simulate agrees with zero
 *     side effects
 *   - a held transfer by the second agent is refused at approval time
 *     by the same gate (403, hold ends, nothing executes)
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import { RvnRpcClient } from '../src/rvn/client.js';
import { AGENT_WALLET_LABEL_PREFIX } from '../src/rvn/wallets.js';
import { RVN_BASE_UNITS_PER_COIN } from '../src/policy/funding.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3131;
const API = `http://127.0.0.1:${API_PORT}`;
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

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
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
const get = (path: string) => req('GET', path);
const post = (path: string, body: unknown) => req('POST', path, body);
const put = (path: string, body: unknown) => req('PUT', path, body);

async function main(): Promise<void> {
  // ================= mock units: per-address asset balances =================
  const mock = new MockRvnNode();
  const agentA = await mock.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-a`);
  const agentB = await mock.getNewAddress(`${AGENT_WALLET_LABEL_PREFIX}agent-b`);
  const throwaway = await mock.getNewAddress();

  check('mock unknown asset reads null, scoped or not',
    (await mock.getAssetBalance('NOPE')) === null &&
    (await mock.getAssetBalance('NOPE', agentA)) === null);

  await mock.issueAsset({ name: 'ISOLCOIN', qty: '100', toAddress: agentA, fromAddress: agentA });
  check('mock issue credits the destination address: per-address reads agree',
    (await mock.getAssetBalance('ISOLCOIN')) === '100' &&
    (await mock.getAssetBalance('ISOLCOIN', agentA)) === '100' &&
    (await mock.getAssetBalance('ISOLCOIN', agentB)) === null &&
    (await mock.getAssetBalance('ISOLCOIN', throwaway)) === null,
    {
      wide: await mock.getAssetBalance('ISOLCOIN'),
      a: await mock.getAssetBalance('ISOLCOIN', agentA),
      b: await mock.getAssetBalance('ISOLCOIN', agentB),
    });

  const scopedA = await mock.listWalletBalances(agentA);
  const scopedB = await mock.listWalletBalances(agentB);
  const wide = await mock.listWalletBalances();
  check('mock listWalletBalances(address) lists only what that address holds',
    scopedA.assets.length === 1 && scopedA.assets[0]?.name === 'ISOLCOIN' &&
    scopedA.assets[0]?.balanceBaseUnits === '100' &&
    scopedB.assets.length === 0 &&
    wide.assets.length === 1 && wide.assets[0]?.balanceBaseUnits === '100',
    { a: scopedA.assets, b: scopedB.assets, wide: wide.assets });

  const rvnBefore = await mock.getRvnBalance(agentA);
  await mock.transferAsset('ISOLCOIN', '40', agentB, agentA);
  check('mock transfer with a fromAddress moves only that address holding',
    (await mock.getAssetBalance('ISOLCOIN', agentA)) === '60' &&
    (await mock.getAssetBalance('ISOLCOIN', agentB)) === '40' &&
    (await mock.getAssetBalance('ISOLCOIN')) === '100',
    {
      a: await mock.getAssetBalance('ISOLCOIN', agentA),
      b: await mock.getAssetBalance('ISOLCOIN', agentB),
    });
  check('mock transfer miner fee (3,500 sat) debits only the fromAddress',
    (await mock.getRvnBalance(agentA)) === (BigInt(rvnBefore) - 3_500n).toString() &&
    (await mock.getRvnBalance(agentB)) === ONE_MILLION_RVN);

  let threw = '';
  try {
    await mock.transferAsset('ISOLCOIN', '61', throwaway, agentA);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('mock transfer above the fromAddress holding throws insufficient',
    /insufficient ISOLCOIN balance at /.test(threw), threw);
  check('mock failed transfer moves nothing and charges no miner fee',
    (await mock.getAssetBalance('ISOLCOIN', agentA)) === '60' &&
    (await mock.getAssetBalance('ISOLCOIN', agentB)) === '40' &&
    (await mock.getRvnBalance(agentA)) === (BigInt(rvnBefore) - 3_500n).toString());

  // A transfer with no fromAddress is a direct node call: the old
  // debit-from-wherever behavior stands, so it still executes.
  await mock.transferAsset('ISOLCOIN', '60', throwaway);
  check('mock transfer without a fromAddress still debits from wherever the balance lives',
    (await mock.getAssetBalance('ISOLCOIN', agentA)) === null &&
    (await mock.getAssetBalance('ISOLCOIN', agentB)) === '40' &&
    (await mock.getAssetBalance('ISOLCOIN')) === '100',
    {
      a: await mock.getAssetBalance('ISOLCOIN', agentA),
      b: await mock.getAssetBalance('ISOLCOIN', agentB),
    });
  const scopedAfterDrain = await mock.listWalletBalances(agentA);
  check('mock drained address lists no assets',
    scopedAfterDrain.assets.length === 0, scopedAfterDrain.assets);

  // ================= real-client units (stubbed fetch) =================
  const realFetch = globalThis.fetch;
  try {
    const stub = async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: unknown[] };
      let result: unknown;
      if (body.method === 'listassetbalancesbyaddress') {
        result = { FOO: 12.5, BAR: 3, ZERO: 0 };
      } else if (body.method === 'getassetdata') {
        const name = body.params[0] as string;
        result = { name, amount: 0, units: name === 'FOO' ? 2 : 0, reissuable: 1 };
      } else if (body.method === 'listmyassets') {
        result = { FOO: { amount: 12.5, units: 2 } };
      } else {
        throw new Error(`unexpected RPC ${body.method}`);
      }
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    };
    globalThis.fetch = stub as unknown as typeof fetch;
    const client = new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' });
    check('real client: per-address asset balance converts display units via getassetdata',
      (await client.getAssetBalance('FOO', 'addr1')) === '1250');
    check('real client: per-address unknown asset is null (never calls getassetdata for it)',
      (await client.getAssetBalance('MISSING', 'addr1')) === null);
    check('real client: per-address zero balance is null',
      (await client.getAssetBalance('ZERO', 'addr1')) === null,
      await client.getAssetBalance('ZERO', 'addr1'));
    check('real client: wallet-wide asset balance still reads listmyassets',
      (await client.getAssetBalance('FOO')) === '1250');

    // A null per-address list means the address holds nothing.
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      const result = body.method === 'listassetbalancesbyaddress' ? null : { name: 'FOO', amount: 0, units: 2, reissuable: 1 };
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    }) as unknown as typeof fetch;
    check('real client: null listassetbalancesbyaddress means no assets at that address',
      (await client.getAssetBalance('FOO', 'addr1')) === null);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ================= booted-API integration =================
  const api = await bootApi(API_PORT);
  try {
    const health = await get('/v1/health');
    check('API booted in mock mode', health.json?.ok === true && health.json?.mock === true);

    // Agent-1: provision its wallet address, allowlist it plus a
    // throwaway destination, issue to its own address.
    const addr1 = (await get('/v1/wallet/address/agent-1')).json?.address as string;
    check('agent-1 wallet address provisioned', typeof addr1 === 'string' && addr1.length > 0, addr1);
    const dest = (await post('/v1/wallets', {})).json?.address as string;
    check('destination wallet provisioned', typeof dest === 'string' && dest.length > 0, dest);
    const base1 = await get('/v1/policies/agent-1');
    const put1 = await put('/v1/policies/agent-1', {
      ...base1.json, agentId: 'agent-1', allowedDestinations: [addr1, dest],
    });
    check('agent-1 policy allowlists its own wallet and the destination', put1.status === 200, put1.json);

    const issue = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'SHARECOIN', qty: '500', toAddress: addr1,
    });
    check('agent-1 issues 500 SHARECOIN to its own wallet address (ALLOW)',
      issue.status === 200 && issue.json?.decision?.kind === 'ALLOW' && typeof issue.json?.txid === 'string', issue.json);

    const transfer = await post('/v1/assets/transfer', {
      agentId: 'agent-1', assetName: 'SHARECOIN', qty: '100', destination: dest,
    });
    check('agent-1 transfers 100 onward (ALLOW, executes)',
      transfer.status === 200 && transfer.json?.decision?.kind === 'ALLOW' && typeof transfer.json?.txid === 'string', transfer.json);

    const agent1Balances = await get('/v1/wallet/balances?agentId=agent-1');
    check('agent-1 scoped balances show only what its address still holds (400)',
      agent1Balances.status === 200 &&
      agent1Balances.json?.assets?.length === 1 &&
      agent1Balances.json.assets[0]?.name === 'SHARECOIN' &&
      agent1Balances.json.assets[0]?.balanceBaseUnits === '400' &&
      agent1Balances.json?.rvnBaseUnits === (BigInt(ONE_MILLION_RVN) - 500n * RVN_BASE_UNITS_PER_COIN - 5_000n - 3_500n).toString(),
      agent1Balances.json);
    const wideBalances = await get('/v1/wallet/balances');
    check('wallet-wide balances are the operator wallet only: no SHARECOIN (it lives in agent-1\'s wallet since v0.43.0)',
      wideBalances.status === 200 &&
      Array.isArray(wideBalances.json?.assets) &&
      !wideBalances.json.assets.some((a: any) => a.name === 'SHARECOIN'),
      wideBalances.json?.assets);

    // Agent-2: its own wallet address holds none of SHARECOIN, so the
    // funding gate refuses the transfer even though the wallet as a
    // whole holds 500.
    const base2 = await get('/v1/policies/agent-2');
    const put2 = await put('/v1/policies/agent-2', {
      ...base2.json, agentId: 'agent-2', allowedDestinations: [dest],
    });
    check('agent-2 policy allowlists the destination', put2.status === 200, put2.json);
    const agent2Balances = await get('/v1/wallet/balances?agentId=agent-2');
    check('agent-2 scoped balances list no SHARECOIN',
      agent2Balances.status === 200 &&
      Array.isArray(agent2Balances.json?.assets) &&
      !agent2Balances.json.assets.some((a: any) => a.name === 'SHARECOIN'),
      agent2Balances.json?.assets);

    const auditBefore = await get('/v1/audit?limit=1');
    const seqBefore = auditBefore.json?.entries?.[0]?.seq ?? 0;
    const denied = await post('/v1/assets/transfer', {
      agentId: 'agent-2', assetName: 'SHARECOIN', qty: '100', destination: dest,
    });
    check("agent-2 cannot transfer agent-1's asset: 403 DENY INSUFFICIENT_ASSET_BALANCE",
      denied.status === 403 && denied.json?.decision?.kind === 'DENY' &&
      denied.json?.decision?.reasonCodes?.length === 1 &&
      denied.json?.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE'),
      denied.json);
    check('agent-2 funding object carries the null balance (its address holds none)',
      denied.json?.funding?.asset === 'SHARECOIN' &&
      denied.json?.funding?.requiredBaseUnits === '100' &&
      denied.json?.funding?.balanceBaseUnits === null &&
      denied.json?.funding?.funded === false,
      denied.json?.funding);

    const auditAfterDenied = await get('/v1/audit?limit=1');
    const seqAfterDenied = auditAfterDenied.json?.entries?.[0]?.seq ?? 0;
    check('the gated denial is audited as one DECISION entry',
      seqAfterDenied === seqBefore + 1, { before: seqBefore, after: seqAfterDenied });
    const simDenied = await post('/v1/intents/simulate', {
      op: 'transfer', agentId: 'agent-2', assetName: 'SHARECOIN', qty: '100', destination: dest,
    });
    check('simulate agrees for agent-2 (DENY, funding object, zero side effects)',
      simDenied.status === 200 && simDenied.json?.decision?.kind === 'DENY' &&
      simDenied.json?.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE') &&
      simDenied.json?.funding?.funded === false,
      simDenied.json);
    const auditAfterSim = await get('/v1/audit?limit=1');
    check('simulate wrote no audit entries',
      (auditAfterSim.json?.entries?.[0]?.seq ?? 0) === seqAfterDenied,
      { afterDenied: seqAfterDenied, afterSim: auditAfterSim.json?.entries?.[0]?.seq });

    const simFunded = await post('/v1/intents/simulate', {
      op: 'transfer', agentId: 'agent-1', assetName: 'SHARECOIN', qty: '100', destination: dest,
    });
    check('simulate for agent-1 still ALLOWs (its address holds 400)',
      simFunded.status === 200 && simFunded.json?.decision?.kind === 'ALLOW' &&
      simFunded.json?.funding?.funded === true &&
      simFunded.json?.funding?.balanceBaseUnits === '400',
      simFunded.json);

    // A held transfer by agent-2 is refused at approval time by the
    // same gate: the hold ends as a clean funding DENY, nothing moves.
    const held = await post('/v1/assets/transfer', {
      agentId: 'agent-2', assetName: 'SHARECOIN', qty: '100', destination: STRANGER,
    });
    check('agent-2 transfer to an unknown destination holds (202)',
      held.status === 202 && held.json?.decision?.kind === 'REQUIRE_APPROVAL', held.json);
    const refused = await post(`/v1/intents/${held.json.intent?.id}/approve`, { approver: 'paul' });
    check('approving the held transfer is refused by the funding gate (403)',
      refused.status === 403 && refused.json?.decision?.kind === 'DENY' &&
      refused.json?.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE') &&
      refused.json?.funding?.funded === false,
      refused.json);
    const reApprove = await post(`/v1/intents/${held.json.intent?.id}/approve`, { approver: 'paul' });
    check('the refused hold is over (approve -> 409)', reApprove.status === 409, reApprove.json);
    const afterAll = await get('/v1/wallet/balances?agentId=agent-1');
    check('nothing moved: agent-1 still holds 400 SHARECOIN',
      afterAll.json?.assets?.find((a: any) => a.name === 'SHARECOIN')?.balanceBaseUnits === '400',
      afterAll.json?.assets);

    const audit = await get('/v1/audit?limit=100');
    check('audit chain valid', audit.json?.chainValid === true, audit.json);
  } finally {
    api.kill();
  }

  console.log(failures === 0 ? 'per-address-asset-test: all green' : `per-address-asset-test: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
