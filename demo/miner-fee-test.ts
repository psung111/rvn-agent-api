/**
 * miner-fee-test: checks for miner-fee estimation in the funding check (v0.39.0).
 *
 *  pnpm test:miner-fee
 *
 * Units: the per-op transaction-size estimates, the miner-fee math
 * (exact kilobyte, partial kilobyte rounds up, zero rate), checkFunding
 * against the mock node (an issue's RVN requirement is fee + miner fee,
 * a transfer's miner fee is a second RVN leg with its own balance, a
 * transfer whose RVN cannot cover the miner fee DENYs with
 * INSUFFICIENT_RVN_BALANCE, an unestimable rate degrades to fee-only,
 * a throwing or malformed or missing estimate method degrades the same
 * way), the real client's estimatesmartfee parsing against a stubbed
 * fetch (rate conversion, errors / feerate -1 / missing feerate / RPC
 * failure all -> null), and the mock node's fee debiting (an issue
 * debits fee + miner fee, a transfer debits the miner fee, a failed
 * call charges nothing, a transfer the wallet cannot pay the miner fee
 * for throws before moving any asset).
 *
 * Integration: boots three real APIs as child processes (MOCK_RVN=true):
 *   - API1 (default 1,000,000 RVN wallet): issue / transfer / sub-asset /
 *     unique simulations report the miner-fee leg (rate, size, fee) and
 *     the requirement including it; simulations have zero side effects.
 *   - API2 (100 RVN wallet): an issue DENYs (500 RVN fee + miner fee);
 *     a reissue DENYs — the headline case — because the wallet holds
 *     exactly the 100 RVN issuance fee with no room for the 4,000 sat
 *     miner fee; a unique still ALLOWs; a real issue is refused by the
 *     funding gate with 403.
 *   - API3 (100 RVN + 4,000 sat wallet): a reissue ALLOWs at exactly
 *     fee + miner fee — the boundary the estimate draws.
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import { RvnRpcClient } from '../src/rvn/client.js';
import type { RvnNode } from '../src/rvn/types.js';
import {
  checkFunding,
  ESTIMATED_TX_SIZE_VBYTES,
  estimateMinerFeeBaseUnits,
} from '../src/policy/funding.js';
import type { RvnIntent } from '../src/policy/types.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3146;
const API2_PORT = 3147;
const API3_PORT = 3148;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const API3 = `http://127.0.0.1:${API3_PORT}`;
const AGENT = 'miner-fee-agent';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

function intent(kind: RvnIntent['kind'], assetName: string, qty: string): RvnIntent {
  return {
    id: 'test-intent',
    agentId: AGENT,
    kind,
    assetName,
    qtyBaseUnits: qty,
    destination: 'mtest1wallet000001xxxxxxxxxxxx',
    requestedAtMs: Date.now(),
  };
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

async function main() {
  // ================= units: size estimates + fee math =================
  check('issue tx estimated at 500 vB', ESTIMATED_TX_SIZE_VBYTES.issue_asset === 500);
  check('reissue tx estimated at 400 vB', ESTIMATED_TX_SIZE_VBYTES.reissue_asset === 400);
  check('sub-asset tx estimated at 500 vB', ESTIMATED_TX_SIZE_VBYTES.issue_subasset === 500);
  check('unique tx estimated at 400 vB', ESTIMATED_TX_SIZE_VBYTES.issue_unique === 400);
  check('transfer tx estimated at 350 vB', ESTIMATED_TX_SIZE_VBYTES.transfer_asset === 350);

  check('10,000 sat/kB x 500 vB = 5,000 sat miner fee',
    estimateMinerFeeBaseUnits('issue_asset', '10000') === '5000');
  check('10,000 sat/kB x 400 vB = 4,000 sat miner fee',
    estimateMinerFeeBaseUnits('reissue_asset', '10000') === '4000');
  check('10,000 sat/kB x 350 vB = 3,500 sat miner fee',
    estimateMinerFeeBaseUnits('transfer_asset', '10000') === '3500');
  check('partial kilobyte rounds up (1 sat/kB x 500 vB = 0.5 -> 1)',
    estimateMinerFeeBaseUnits('issue_asset', '1') === '1');
  check('partial kilobyte rounds up (1 sat/kB x 350 vB = 0.35 -> 1)',
    estimateMinerFeeBaseUnits('transfer_asset', '1') === '1');
  check('zero rate means zero miner fee',
    estimateMinerFeeBaseUnits('issue_asset', '0') === '0');
  check('a high rate scales linearly (1,000,000 sat/kB x 500 vB = 500,000 sat)',
    estimateMinerFeeBaseUnits('issue_asset', '1000000') === '500000');

  // ================= units: checkFunding against the mock =================
  const mock = new MockRvnNode();
  await mock.issueAsset({ name: 'MOCKCOIN', qty: '600', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  const iFunded = await checkFunding(intent('issue_asset', 'ANOTHER', '1'), mock);
  check('mock: issue requirement is the 500 RVN fee + 5,000 sat miner fee',
    iFunded.requiredBaseUnits === '50000005000' && iFunded.asset === 'RVN' &&
    iFunded.reasonCode === 'INSUFFICIENT_RVN_BALANCE', iFunded);
  check('mock: issue miner-fee leg carries rate, size, and fee',
    iFunded.minerFee?.requiredBaseUnits === '5000' &&
    iFunded.minerFee?.rateBaseUnitsPerKb === '10000' &&
    iFunded.minerFee?.estimatedTxSizeVbytes === 500, iFunded.minerFee);
  check('mock: issue is funded from the default wallet',
    iFunded.funded === true && iFunded.balanceBaseUnits === '99949999995000', iFunded);
  // (999,499.99995 RVN: the MOCKCOIN issue above already paid 500 RVN + 5,000 sat.)
  const tFunded = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '100'), mock);
  check('mock: transfer requirement stays the asset qty',
    tFunded.asset === 'MOCKCOIN' && tFunded.requiredBaseUnits === '100' &&
    tFunded.balanceBaseUnits === '600' && tFunded.funded === true, tFunded);
  check('mock: transfer miner-fee leg carries the RVN balance behind it',
    tFunded.minerFee?.requiredBaseUnits === '3500' &&
    tFunded.minerFee?.rateBaseUnitsPerKb === '10000' &&
    tFunded.minerFee?.estimatedTxSizeVbytes === 350 &&
    tFunded.minerFee?.balanceBaseUnits === '99949999995000', tFunded.minerFee);

  // A wallet holding the asset but too little RVN for the miner fee:
  // the transfer DENYs on the RVN leg, not the asset leg.
  const shortRvn = {
    getAssetBalance: async (): Promise<string | null> => '600',
    getRvnBalance: async (): Promise<string> => '3000',
    estimateFeeRateBaseUnitsPerKb: async (): Promise<string | null> => '10000',
  } as unknown as RvnNode;
  const tShortRvn = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '100'), shortRvn);
  check('transfer with 3,000 sat RVN vs a 3,500 sat miner fee -> DENY INSUFFICIENT_RVN_BALANCE',
    tShortRvn.funded === false && tShortRvn.reasonCode === 'INSUFFICIENT_RVN_BALANCE' &&
    tShortRvn.minerFee?.balanceBaseUnits === '3000', tShortRvn);
  const exactRvn = {
    getAssetBalance: async (): Promise<string | null> => '600',
    getRvnBalance: async (): Promise<string> => '3500',
    estimateFeeRateBaseUnitsPerKb: async (): Promise<string | null> => '10000',
  } as unknown as RvnNode;
  const tExactRvn = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '100'), exactRvn);
  check('transfer with exactly the 3,500 sat miner fee in RVN is funded',
    tExactRvn.funded === true && tExactRvn.minerFee?.balanceBaseUnits === '3500', tExactRvn);

  // ================= units: degradation when the rate is unestimable =================
  process.env.MOCK_FEE_RATE_BASE_UNITS_PER_KB = 'null';
  const noRateMock = new MockRvnNode();
  const iNoRate = await checkFunding(intent('issue_asset', 'NORATE', '1'), noRateMock);
  check('unestimable mock rate: miner-fee leg reports nulls, requirement is fee-only',
    iNoRate.minerFee?.requiredBaseUnits === null && iNoRate.minerFee?.rateBaseUnitsPerKb === null &&
    iNoRate.minerFee?.estimatedTxSizeVbytes === 500 &&
    iNoRate.requiredBaseUnits === '50000000000' && iNoRate.funded === true, iNoRate);
  const tNoRate = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '1'), noRateMock);
  check('unestimable mock rate: transfer of a never-held asset still DENYs on the asset leg',
    tNoRate.funded === false && tNoRate.balanceBaseUnits === null &&
    tNoRate.minerFee?.requiredBaseUnits === null, tNoRate);
  await noRateMock.issueAsset({ name: 'NORATECOIN', qty: '600', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  const tNoRateHeld = await checkFunding(intent('transfer_asset', 'NORATECOIN', '100'), noRateMock);
  check('unestimable mock rate: transfer of a held asset funds on the asset leg alone',
    tNoRateHeld.funded === true && tNoRateHeld.balanceBaseUnits === '600' &&
    tNoRateHeld.minerFee?.requiredBaseUnits === null &&
    tNoRateHeld.minerFee?.rateBaseUnitsPerKb === null, tNoRateHeld);
  check('unestimable mock rate: the issue paid the fee only, no miner fee',
    (await noRateMock.getRvnBalance()) === '99950000000000');
  delete process.env.MOCK_FEE_RATE_BASE_UNITS_PER_KB;

  const nullRate = {
    getAssetBalance: async (): Promise<string | null> => '600',
    getRvnBalance: async (): Promise<string> => '100000000000000',
    estimateFeeRateBaseUnitsPerKb: async (): Promise<string | null> => null,
  } as unknown as RvnNode;
  const iNullRate = await checkFunding(intent('issue_asset', 'NORATE2', '1'), nullRate);
  check('stub node returning null rate: fee-only requirement, funded',
    iNullRate.minerFee?.requiredBaseUnits === null && iNullRate.requiredBaseUnits === '50000000000' &&
    iNullRate.funded === true, iNullRate);

  const throwingRate = {
    getAssetBalance: async (): Promise<string | null> => '600',
    getRvnBalance: async (): Promise<string> => '100000000000000',
    estimateFeeRateBaseUnitsPerKb: async (): Promise<string | null> => {
      throw new Error('fee data unavailable');
    },
  } as unknown as RvnNode;
  const iThrowRate = await checkFunding(intent('issue_asset', 'THROW', '1'), throwingRate);
  check('throwing fee-rate lookup degrades to fee-only and records the error',
    iThrowRate.minerFee?.requiredBaseUnits === null &&
    iThrowRate.minerFee?.error === 'fee data unavailable' &&
    iThrowRate.requiredBaseUnits === '50000000000' && iThrowRate.funded === true, iThrowRate);

  const noMethod = {
    getAssetBalance: async (): Promise<string | null> => '600',
    getRvnBalance: async (): Promise<string> => '100000000000000',
  } as unknown as RvnNode;
  const iNoMethod = await checkFunding(intent('issue_asset', 'NOMETHOD', '1'), noMethod);
  check('node without the estimate method degrades to fee-only, never throws',
    iNoMethod.minerFee?.requiredBaseUnits === null && iNoMethod.requiredBaseUnits === '50000000000' &&
    iNoMethod.funded === true, iNoMethod);

  const badRate = {
    getAssetBalance: async (): Promise<string | null> => '600',
    getRvnBalance: async (): Promise<string> => '100000000000000',
    estimateFeeRateBaseUnitsPerKb: async (): Promise<string | null> => 'abc',
  } as unknown as RvnNode;
  const iBadRate = await checkFunding(intent('issue_asset', 'BADRATE', '1'), badRate);
  check('malformed fee rate degrades to fee-only and records the error',
    iBadRate.minerFee?.requiredBaseUnits === null &&
    iBadRate.minerFee?.error === 'malformed fee rate: abc' &&
    iBadRate.funded === true, iBadRate);

  // ================= units: real-client estimatesmartfee (stubbed fetch) =================
  const realFetch = globalThis.fetch;
  try {
    const stub = async (url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: unknown[] };
      let result: unknown;
      let error: unknown = null;
      if (body.method === 'estimatesmartfee') {
        // The conf target rides along: 6 blocks.
        if (JSON.stringify(body.params) !== JSON.stringify([6])) {
          throw new Error(`unexpected estimatesmartfee params ${JSON.stringify(body.params)}`);
        }
        result = { feerate: 0.0001, blocks: 6 };
      } else {
        throw new Error(`unexpected RPC ${body.method}`);
      }
      return new Response(JSON.stringify({ result, error }), { status: 200 });
    };
    globalThis.fetch = stub as unknown as typeof fetch;
    const client = new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' });
    check('real client: 0.0001 RVN/kB -> 10,000 base units/kB',
      (await client.estimateFeeRateBaseUnitsPerKb()) === '10000');

    // feerate -1 / errors list / missing feerate -> null.
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      const result =
        body.method === 'estimatesmartfee' ? { feerate: -1, blocks: 6, errors: ['Insufficient data'] } : null;
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    }) as unknown as typeof fetch;
    check('real client: feerate -1 with errors -> null',
      (await new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' }).estimateFeeRateBaseUnitsPerKb()) === null);

    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      const result = body.method === 'estimatesmartfee' ? { blocks: 6 } : null;
      return new Response(JSON.stringify({ result, error: null }), { status: 200 });
    }) as unknown as typeof fetch;
    check('real client: missing feerate -> null',
      (await new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' }).estimateFeeRateBaseUnitsPerKb()) === null);

    // An RPC error (too little fee data) -> null, never a throw.
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ result: null, error: { message: 'Insufficient data or no feerate found' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    check('real client: estimatesmartfee RPC error -> null',
      (await new RvnRpcClient({ url: 'http://127.0.0.1:1', user: 'u', pass: 'p' }).estimateFeeRateBaseUnitsPerKb()) === null);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ================= units: mock fee debiting =================
  const debitMock = new MockRvnNode();
  await debitMock.issueAsset({ name: 'DEBITCOIN', qty: '600', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  check('mock issue debits the 500 RVN fee + 5,000 sat miner fee',
    (await debitMock.getRvnBalance()) === '99949999995000');
  await debitMock.transferAsset('DEBITCOIN', '100', 'mtest1other000002xxxxxxxxxxxx');
  check('mock transfer debits the 3,500 sat miner fee',
    (await debitMock.getRvnBalance()) === '99949999991500');
  // A wallet with exactly the issue cost (500 RVN + 5,000 sat) issues,
  // then cannot pay the next transfer's miner fee — and the failed
  // transfer moves no asset and charges nothing.
  process.env.MOCK_RVN_BALANCE_BASE_UNITS = '50000005000';
  const exactMock = new MockRvnNode();
  await exactMock.issueAsset({ name: 'EXACTCOIN', qty: '600', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  check('mock with exactly fee + miner fee issues and lands at 0 RVN',
    (await exactMock.getRvnBalance()) === '0');
  let transferThrew = '';
  try {
    await exactMock.transferAsset('EXACTCOIN', '100', 'mtest1other000002xxxxxxxxxxxx');
  } catch (e) {
    transferThrew = e instanceof Error ? e.message : String(e);
  }
  check('mock transfer with 0 RVN throws on the miner fee before moving anything',
    /insufficient RVN balance for transfer miner fee/.test(transferThrew), transferThrew);
  check('failed transfer charged nothing (RVN still 0, asset still held in full)',
    (await exactMock.getRvnBalance()) === '0' &&
    (await exactMock.getAssetBalance('EXACTCOIN')) === '600');
  delete process.env.MOCK_RVN_BALANCE_BASE_UNITS;
  process.env.MOCK_RVN_BALANCE_BASE_UNITS = '10000000000'; // 100 RVN
  const poorMock = new MockRvnNode();
  let issueThrew = '';
  try {
    await poorMock.issueAsset({ name: 'POORCOIN', qty: '10', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  } catch (e) {
    issueThrew = e instanceof Error ? e.message : String(e);
  }
  check('low-RVN mock refuses an issue (500 RVN fee + miner fee)',
    /insufficient RVN balance/.test(issueThrew), issueThrew);
  check('failed issue charged no fee (balance still 100 RVN)',
    (await poorMock.getRvnBalance()) === '10000000000');
  delete process.env.MOCK_RVN_BALANCE_BASE_UNITS;

  // ================= integration: default mock wallet =================
  const api1 = await bootApi(API1_PORT);
  const req1 = {
    post: async (path: string, body: unknown) => {
      const res = await fetch(`${API1}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as any };
    },
    put: async (path: string, body: unknown) => {
      const res = await fetch(`${API1}${path}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as any };
    },
    get: async (path: string) => (await (await fetch(`${API1}${path}`)).json()) as any,
  };
  try {
    const { address } = (await req1.post('/v1/wallets', {})).json;
    const base = await req1.get(`/v1/policies/${AGENT}`);
    const putPolicy = await req1.put(`/v1/policies/${AGENT}`, {
      ...base, agentId: AGENT, allowedDestinations: [address], dailyIssueBudgetBaseUnits: '10000',
    });
    check('policy updated for miner-fee-agent', putPolicy.status === 200);

    const lastSeq = async (): Promise<number> => {
      const tail = await req1.get('/v1/audit?limit=1');
      return tail.entries.length ? tail.entries[0].seq : 0;
    };

    // --- A. issue simulation: ALLOW with fee + miner fee required ---
    const simIssue = await req1.post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'MINERNEW', qty: '500', destination: address,
    });
    check('issue simulate -> ALLOW',
      simIssue.status === 200 && simIssue.json.decision?.kind === 'ALLOW', simIssue.json);
    check('issue simulate requires 500 RVN + 5,000 sat miner fee',
      simIssue.json.funding?.asset === 'RVN' && simIssue.json.funding?.requiredBaseUnits === '50000005000' &&
      simIssue.json.funding?.balanceBaseUnits === '100000000000000' && simIssue.json.funding?.funded === true,
      simIssue.json.funding);
    check('issue simulate miner-fee leg: 5,000 sat at 10,000 sat/kB for 500 vB',
      simIssue.json.funding?.minerFee?.requiredBaseUnits === '5000' &&
      simIssue.json.funding?.minerFee?.rateBaseUnitsPerKb === '10000' &&
      simIssue.json.funding?.minerFee?.estimatedTxSizeVbytes === 500, simIssue.json.funding?.minerFee);

    // --- B. transfer simulation against a really-issued asset ---
    const real = await req1.post('/v1/assets/issue', {
      agentId: AGENT, name: 'MINERCOIN', qty: '600', toAddress: address,
    });
    check('real issue of MINERCOIN 600 ALLOWs', real.status === 200 && real.json.decision?.kind === 'ALLOW');
    const seqAfterReal = await lastSeq();
    const simTransfer = await req1.post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'MINERCOIN', qty: '100', destination: address,
    });
    check('transfer within balance -> ALLOW',
      simTransfer.status === 200 && simTransfer.json.decision?.kind === 'ALLOW', simTransfer.json);
    check('transfer funding still requires the asset qty up top',
      simTransfer.json.funding?.asset === 'MINERCOIN' && simTransfer.json.funding?.requiredBaseUnits === '100' &&
      simTransfer.json.funding?.balanceBaseUnits === '600' && simTransfer.json.funding?.funded === true,
      simTransfer.json.funding);
    check('transfer miner-fee leg: 3,500 sat for 350 vB, RVN balance behind it',
      simTransfer.json.funding?.minerFee?.requiredBaseUnits === '3500' &&
      simTransfer.json.funding?.minerFee?.rateBaseUnitsPerKb === '10000' &&
      simTransfer.json.funding?.minerFee?.estimatedTxSizeVbytes === 350 &&
      simTransfer.json.funding?.minerFee?.balanceBaseUnits === '99949999995000',
      simTransfer.json.funding?.minerFee);

    // --- C. sub-asset / unique simulations report fee + miner fee ---
    const simSub = await req1.post('/v1/intents/simulate', {
      op: 'subasset', agentId: AGENT, assetName: 'MINERCOIN/SIM', qty: '10', destination: address,
    });
    check('sub-asset simulate -> ALLOW with 100 RVN + 5,000 sat required',
      simSub.status === 200 && simSub.json.decision?.kind === 'ALLOW' &&
      simSub.json.funding?.requiredBaseUnits === '10000005000' && simSub.json.funding?.funded === true &&
      simSub.json.funding?.minerFee?.requiredBaseUnits === '5000', simSub.json);
    const simUnique = await req1.post('/v1/intents/simulate', {
      op: 'unique', agentId: AGENT, assetName: 'MINERCOIN#SIM1', destination: address,
    });
    check('unique simulate -> ALLOW with 5 RVN + 4,000 sat required',
      simUnique.status === 200 && simUnique.json.decision?.kind === 'ALLOW' &&
      simUnique.json.funding?.requiredBaseUnits === '500004000' && simUnique.json.funding?.funded === true &&
      simUnique.json.funding?.minerFee?.requiredBaseUnits === '4000', simUnique.json);

    // --- D. zero side effects from all the simulations ---
    check('simulations wrote no audit entries', (await lastSeq()) === seqAfterReal, {
      before: seqAfterReal, after: await lastSeq(),
    });
    check('no simulated intent is pending', (await req1.get('/v1/intents/pending')).pending.length === 0);
  } finally {
    api1.kill();
  }

  // ================= integration: low-RVN wallet (100 RVN) =================
  const api2 = await bootApi(API2_PORT, { MOCK_RVN_BALANCE_BASE_UNITS: '10000000000' });
  const req2 = {
    post: async (path: string, body: unknown) => {
      const res = await fetch(`${API2}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as any };
    },
    put: async (path: string, body: unknown) => {
      const res = await fetch(`${API2}${path}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as any };
    },
    get: async (path: string) => (await (await fetch(`${API2}${path}`)).json()) as any,
  };
  try {
    const { address } = (await req2.post('/v1/wallets', {})).json;
    const base2 = await req2.get(`/v1/policies/${AGENT}`);
    const put2 = await req2.put(`/v1/policies/${AGENT}`, {
      ...base2, agentId: AGENT, allowedDestinations: [address],
    });
    check('policy updated for miner-fee-agent on the low-RVN API', put2.status === 200);
    // Issue: 500 RVN fee + 5,000 sat miner fee vs a 100 RVN wallet.
    const simPoor = await req2.post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'POORNEW', qty: '10', destination: address,
    });
    check('low-RVN issue simulate -> DENY INSUFFICIENT_RVN_BALANCE',
      simPoor.status === 200 && simPoor.json.decision?.kind === 'DENY' &&
      simPoor.json.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE'), simPoor.json.decision);
    check('low-RVN issue funding requires 500 RVN + 5,000 sat vs 100 RVN held',
      simPoor.json.funding?.funded === false && simPoor.json.funding?.balanceBaseUnits === '10000000000' &&
      simPoor.json.funding?.requiredBaseUnits === '50000005000' &&
      simPoor.json.funding?.minerFee?.requiredBaseUnits === '5000', simPoor.json.funding);
    // Reissue: the wallet holds exactly the 100 RVN issuance fee — and
    // that used to simulate as funded. With the 4,000 sat miner fee on
    // top, it no longer does.
    const simReissuePoor = await req2.post('/v1/intents/simulate', {
      op: 'reissue', agentId: AGENT, assetName: 'POORROOT', qty: '10', destination: address,
    });
    check('low-RVN reissue simulate -> DENY: exactly the fee, no room for the miner fee',
      simReissuePoor.status === 200 && simReissuePoor.json.decision?.kind === 'DENY' &&
      simReissuePoor.json.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE'), simReissuePoor.json.decision);
    check('low-RVN reissue funding requires 100 RVN + 4,000 sat vs 100 RVN held',
      simReissuePoor.json.funding?.funded === false &&
      simReissuePoor.json.funding?.balanceBaseUnits === '10000000000' &&
      simReissuePoor.json.funding?.requiredBaseUnits === '10000004000' &&
      simReissuePoor.json.funding?.minerFee?.requiredBaseUnits === '4000', simReissuePoor.json.funding);
    // Unique (5 RVN + 4,000 sat) still fits in 100 RVN.
    const simUniquePoor = await req2.post('/v1/intents/simulate', {
      op: 'unique', agentId: AGENT, assetName: 'POORROOT#TAG1', destination: address,
    });
    check('low-RVN unique simulate -> ALLOW (5 RVN + 4,000 sat fits)',
      simUniquePoor.status === 200 && simUniquePoor.json.decision?.kind === 'ALLOW' &&
      simUniquePoor.json.funding?.funded === true &&
      simUniquePoor.json.funding?.requiredBaseUnits === '500004000', simUniquePoor.json);
    // The funding gate refuses the doomed submit outright (403, not 502).
    const realPoor = await req2.post('/v1/assets/issue', {
      agentId: AGENT, name: 'POORNEW', qty: '10', toAddress: address,
    });
    check('low-RVN real issue is refused by the funding gate (403, not 502)',
      realPoor.status === 403 && realPoor.json?.decision?.kind === 'DENY' &&
      realPoor.json?.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE') &&
      realPoor.json?.funding?.funded === false &&
      realPoor.json?.funding?.requiredBaseUnits === '50000005000', realPoor.json);
    const noAsset = await fetch(`${API2}/v1/assets/POORNEW`);
    check('failed low-RVN issue created no asset', noAsset.status === 404);
  } finally {
    api2.kill();
  }

  // ================= integration: boundary wallet (100 RVN + 4,000 sat) =================
  const api3 = await bootApi(API3_PORT, { MOCK_RVN_BALANCE_BASE_UNITS: '10000004000' });
  const req3 = {
    post: async (path: string, body: unknown) => {
      const res = await fetch(`${API3}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as any };
    },
    put: async (path: string, body: unknown) => {
      const res = await fetch(`${API3}${path}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as any };
    },
    get: async (path: string) => (await (await fetch(`${API3}${path}`)).json()) as any,
  };
  try {
    const { address } = (await req3.post('/v1/wallets', {})).json;
    const base3 = await req3.get(`/v1/policies/${AGENT}`);
    const put3 = await req3.put(`/v1/policies/${AGENT}`, {
      ...base3, agentId: AGENT, allowedDestinations: [address],
    });
    check('policy updated for miner-fee-agent on the boundary API', put3.status === 200);
    // Exactly fee + miner fee: the reissue ALLOWs at the boundary.
    const simBoundary = await req3.post('/v1/intents/simulate', {
      op: 'reissue', agentId: AGENT, assetName: 'POORROOT', qty: '10', destination: address,
    });
    check('boundary reissue simulate -> ALLOW at exactly 100 RVN + 4,000 sat',
      simBoundary.status === 200 && simBoundary.json.decision?.kind === 'ALLOW' &&
      simBoundary.json.funding?.funded === true &&
      simBoundary.json.funding?.balanceBaseUnits === '10000004000' &&
      simBoundary.json.funding?.requiredBaseUnits === '10000004000', simBoundary.json);
    // One sat less than the miner fee would DENY — proved by the API2
    // leg above (100 RVN exactly); here an issue is still far out of reach.
    const simIssueBoundary = await req3.post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'BOUNDARYNEW', qty: '10', destination: address,
    });
    check('boundary issue simulate -> DENY (500 RVN fee far above the balance)',
      simIssueBoundary.status === 200 && simIssueBoundary.json.decision?.kind === 'DENY' &&
      simIssueBoundary.json.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE'), simIssueBoundary.json.decision);
  } finally {
    api3.kill();
  }

  console.log(failures ? `miner-fee-test: FAILED (${failures})` : 'miner-fee-test: all green');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
