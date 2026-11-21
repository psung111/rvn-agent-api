/**
 * funding-test: checks for balance-aware simulate (v0.36.0).
 *
 *  pnpm test:funding
 *
 * Units: the funding requirement per intent kind, the RVN issuance-fee
 * constants, the decimal-to-base-units conversion, applyFunding's
 * ALLOW->DENY flip, checkFunding against the mock node (including a
 * throwing node degrading to funded:null), and the mock node's fee
 * debiting (a low-RVN mock refuses an issue and pays 5 RVN for a
 * unique asset).
 *
 * Integration: boots the real API as a child process (MOCK_RVN=true)
 * and asserts:
 *   - an issue simulation ALLOWs with a funded RVN fee report
 *   - a transfer simulation ALLOWs when the wallet holds the asset,
 *     DENYs INSUFFICIENT_ASSET_BALANCE when it holds less, and DENYs
 *     the same for an asset the wallet never held (balance null)
 *   - sub-asset / unique simulations report their RVN fees
 *   - a policy DENY or hold carries no funding object (the check runs
 *     only on ALLOW)
 *   - simulations have zero side effects (audit seq, pending list,
 *     no asset created)
 *   - a second API with MOCK_RVN_BALANCE_BASE_UNITS=100 RVN DENYs an
 *     issue (500 RVN fee), ALLOWs a unique (5 RVN) and a reissue at
 *     exactly the balance (100 RVN), and a real issue against it is
 *     refused by the funding gate with 403 (v0.37.0 — no longer a 502
 *     from the node) and creates no asset.
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import { decimalToBaseUnits } from '../src/rvn/client.js';
import type { RvnNode } from '../src/rvn/types.js';
import {
  applyFunding,
  checkFunding,
  fundingRequirementFor,
  ISSUANCE_FEE_BASE_UNITS,
  RVN_BASE_UNITS_PER_COIN,
} from '../src/policy/funding.js';
import type { Decision, RvnIntent } from '../src/policy/types.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3124;
const API2_PORT = 3125;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const AGENT = 'fund-agent';

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

function allowDecision(): Decision {
  return {
    intentId: 'test-intent',
    agentId: AGENT,
    kind: 'ALLOW',
    reasonCodes: ['WITHIN_POLICY'],
    decidedAtMs: 1_000,
    expiresAtMs: 2_000,
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
  // ================= units =================
  // --- 1. fee constants are the Ravencoin consensus issuance fees ---
  check('issue fee is 500 RVN', ISSUANCE_FEE_BASE_UNITS.issue_asset === 500n * RVN_BASE_UNITS_PER_COIN);
  check('reissue fee is 100 RVN', ISSUANCE_FEE_BASE_UNITS.reissue_asset === 100n * RVN_BASE_UNITS_PER_COIN);
  check('sub-asset fee is 100 RVN', ISSUANCE_FEE_BASE_UNITS.issue_subasset === 100n * RVN_BASE_UNITS_PER_COIN);
  check('unique fee is 5 RVN', ISSUANCE_FEE_BASE_UNITS.issue_unique === 5n * RVN_BASE_UNITS_PER_COIN);

  // --- 2. requirement mapping per kind ---
  const transferReq = fundingRequirementFor(intent('transfer_asset', 'FUNDCOIN', '250'));
  check('transfer requires the asset qty',
    transferReq.asset === 'FUNDCOIN' && transferReq.requiredBaseUnits === '250' &&
    transferReq.reasonCode === 'INSUFFICIENT_ASSET_BALANCE', transferReq);
  const issueReq = fundingRequirementFor(intent('issue_asset', 'NEWCOIN', '10'));
  check('issue requires 500 RVN',
    issueReq.asset === 'RVN' && issueReq.requiredBaseUnits === '50000000000' &&
    issueReq.reasonCode === 'INSUFFICIENT_RVN_BALANCE', issueReq);
  check('reissue requires 100 RVN',
    fundingRequirementFor(intent('reissue_asset', 'FUNDCOIN', '10')).requiredBaseUnits === '10000000000');
  check('sub-asset requires 100 RVN',
    fundingRequirementFor(intent('issue_subasset', 'FUNDCOIN/SUB', '10')).requiredBaseUnits === '10000000000');
  check('unique requires 5 RVN',
    fundingRequirementFor(intent('issue_unique', 'FUNDCOIN#TAG', '1')).requiredBaseUnits === '500000000');

  // --- 3. decimal -> base units never goes through a float ---
  check('1.5 RVN -> 150000000 base units', decimalToBaseUnits(1.5, 8) === '150000000');
  check("'500' RVN -> 50000000000", decimalToBaseUnits('500', 8) === '50000000000');
  check('0.00000001 RVN -> 1 base unit', decimalToBaseUnits(0.00000001, 8) === '1');
  check('2.5 asset units (0 dp) -> 2 (truncated)', decimalToBaseUnits('2.5', 0) === '2');
  check('1.234 with 2 dp -> 123 (truncated)', decimalToBaseUnits('1.234', 2) === '123');
  check('integer string with 0 dp', decimalToBaseUnits('42', 0) === '42');
  let threw = false;
  try { decimalToBaseUnits('abc', 8); } catch { threw = true; }
  check("non-decimal input throws", threw);
  threw = false;
  try { decimalToBaseUnits('-1', 8); } catch { threw = true; }
  check('negative input throws', threw);

  // --- 4. applyFunding flips only an unfunded ALLOW ---
  const unfunded = applyFunding(allowDecision(), {
    asset: 'FUNDCOIN', requiredBaseUnits: '250', balanceBaseUnits: '100',
    funded: false, reasonCode: 'INSUFFICIENT_ASSET_BALANCE',
  });
  check('unfunded ALLOW -> DENY with the funding reason code',
    unfunded.kind === 'DENY' && unfunded.reasonCodes.length === 1 &&
    unfunded.reasonCodes[0] === 'INSUFFICIENT_ASSET_BALANCE', unfunded);
  check('flipped decision keeps intent, agent, and TTL window',
    unfunded.intentId === 'test-intent' && unfunded.agentId === AGENT &&
    unfunded.decidedAtMs === 1_000 && unfunded.expiresAtMs === 2_000);
  const funded = applyFunding(allowDecision(), {
    asset: 'RVN', requiredBaseUnits: '50000000000', balanceBaseUnits: '100000000000000',
    funded: true, reasonCode: 'INSUFFICIENT_RVN_BALANCE',
  });
  check('funded ALLOW is untouched', funded.kind === 'ALLOW' && funded.reasonCodes[0] === 'WITHIN_POLICY');
  const unknown = applyFunding(allowDecision(), {
    asset: 'RVN', requiredBaseUnits: '50000000000', balanceBaseUnits: null,
    funded: null, reasonCode: 'INSUFFICIENT_RVN_BALANCE', error: 'node down',
  });
  check('unknown funding leaves the ALLOW untouched', unknown.kind === 'ALLOW');

  // --- 5. checkFunding against the mock node directly ---
  const mock = new MockRvnNode();
  await mock.issueAsset({ name: 'MOCKCOIN', qty: '600', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  const tFunded = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '100'), mock);
  check('mock: transfer within balance is funded',
    tFunded.funded === true && tFunded.balanceBaseUnits === '600', tFunded);
  const tShort = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '601'), mock);
  check('mock: transfer above balance is unfunded with the asset code',
    tShort.funded === false && tShort.reasonCode === 'INSUFFICIENT_ASSET_BALANCE' &&
    tShort.balanceBaseUnits === '600', tShort);
  const tUnknown = await checkFunding(intent('transfer_asset', 'NEVERISSUED', '1'), mock);
  check('mock: transfer of a never-issued asset is unfunded with null balance',
    tUnknown.funded === false && tUnknown.balanceBaseUnits === null, tUnknown);
  const iFunded = await checkFunding(intent('issue_asset', 'ANOTHER', '1'), mock);
  check('mock: issue fee is funded from the default 1,000,000 RVN wallet',
    iFunded.funded === true && iFunded.balanceBaseUnits === '99950000000000', iFunded);
  // (999,500 RVN: the MOCKCOIN issue above already paid its 500 RVN fee.)
  const throwing = {
    getAssetBalance: async (): Promise<string | null> => { throw new Error('node down'); },
    getRvnBalance: async (): Promise<string> => { throw new Error('node down'); },
  } as unknown as RvnNode;
  const tErr = await checkFunding(intent('transfer_asset', 'MOCKCOIN', '1'), throwing);
  check('throwing node -> funded null with the error, never a throw',
    tErr.funded === null && tErr.balanceBaseUnits === null && tErr.error === 'node down', tErr);

  // --- 6. mock fee debiting: a low-RVN mock refuses an issue, pays 5 RVN for a unique ---
  process.env.MOCK_RVN_BALANCE_BASE_UNITS = '10000000000'; // 100 RVN
  const poorMock = new MockRvnNode();
  let issueThrew = '';
  try {
    await poorMock.issueAsset({ name: 'POORCOIN', qty: '10', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  } catch (e) {
    issueThrew = e instanceof Error ? e.message : String(e);
  }
  check('low-RVN mock refuses an issue (500 RVN fee)',
    /insufficient RVN balance/.test(issueThrew), issueThrew);
  check('failed issue created no asset', (await poorMock.getAssetData('POORCOIN')) === null);
  const poorBalance = await poorMock.getRvnBalance();
  check('failed issue charged no fee (balance still 100 RVN)', poorBalance === '10000000000', poorBalance);
  delete process.env.MOCK_RVN_BALANCE_BASE_UNITS;
  const richMock = new MockRvnNode();
  await richMock.issueAsset({ name: 'RICHROOT', qty: '10', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  const beforeUnique = await richMock.getRvnBalance();
  await richMock.issueUniqueAsset({ name: 'RICHROOT#TAG1', toAddress: 'mtest1wallet000001xxxxxxxxxxxx' });
  const afterUnique = await richMock.getRvnBalance();
  check('unique-asset issue debits exactly the 5 RVN fee',
    BigInt(beforeUnique) - BigInt(afterUnique) === 500000000n, { beforeUnique, afterUnique });

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
    const health = await req1.get('/v1/health');
    check('API1 booted in mock mode', health.ok === true && health.mock === true);

    const { address } = (await req1.post('/v1/wallets', {})).json;
    const base = await req1.get(`/v1/policies/${AGENT}`);
    const putPolicy = await req1.put(`/v1/policies/${AGENT}`, {
      ...base, agentId: AGENT, allowedDestinations: [address], dailyIssueBudgetBaseUnits: '10000',
    });
    check('policy updated for fund-agent', putPolicy.status === 200);

    const lastSeq = async (): Promise<number> => {
      const tail = await req1.get('/v1/audit?limit=1');
      return tail.entries.length ? tail.entries[0].seq : 0;
    };

    // --- A. issue simulation: ALLOW with a funded RVN fee report ---
    const simIssue = await req1.post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'FUNDNEW', qty: '500', destination: address,
    });
    check('issue simulate -> ALLOW', simIssue.status === 200 && simIssue.json.decision?.kind === 'ALLOW', simIssue.json);
    check('issue simulate reports the 500 RVN fee as funded',
      simIssue.json.funding?.asset === 'RVN' && simIssue.json.funding?.requiredBaseUnits === '50000000000' &&
      simIssue.json.funding?.balanceBaseUnits === '100000000000000' && simIssue.json.funding?.funded === true,
      simIssue.json.funding);

    // --- B. transfer simulation against a really-issued asset ---
    const real = await req1.post('/v1/assets/issue', {
      agentId: AGENT, name: 'FUNDCOIN', qty: '600', toAddress: address,
    });
    check('real issue of FUNDCOIN 600 ALLOWs', real.status === 200 && real.json.decision?.kind === 'ALLOW');
    // The real issue wrote audit entries; the simulations after it must not.
    const seqAfterReal = await lastSeq();
    const simTransfer = await req1.post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'FUNDCOIN', qty: '100', destination: address,
    });
    check('transfer within balance -> ALLOW',
      simTransfer.status === 200 && simTransfer.json.decision?.kind === 'ALLOW', simTransfer.json);
    check('transfer funding reports the asset balance',
      simTransfer.json.funding?.asset === 'FUNDCOIN' && simTransfer.json.funding?.requiredBaseUnits === '100' &&
      simTransfer.json.funding?.balanceBaseUnits === '600' && simTransfer.json.funding?.funded === true,
      simTransfer.json.funding);

    // --- C. transfer above the balance -> funding DENY ---
    const simOver = await req1.post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'FUNDCOIN', qty: '601', destination: address,
    });
    check('transfer above balance -> DENY INSUFFICIENT_ASSET_BALANCE',
      simOver.status === 200 && simOver.json.decision?.kind === 'DENY' &&
      simOver.json.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE'), simOver.json.decision);
    check('over-balance funding object carries the shortfall',
      simOver.json.funding?.funded === false && simOver.json.funding?.balanceBaseUnits === '600' &&
      simOver.json.funding?.requiredBaseUnits === '601', simOver.json.funding);

    // --- D. transfer of a never-issued asset -> funding DENY, null balance ---
    const simNope = await req1.post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'NEVERISSUED', qty: '1', destination: address,
    });
    check('transfer of a never-issued asset -> DENY INSUFFICIENT_ASSET_BALANCE',
      simNope.status === 200 && simNope.json.decision?.kind === 'DENY' &&
      simNope.json.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE'), simNope.json.decision);
    check('never-issued funding balance is null',
      simNope.json.funding?.funded === false && simNope.json.funding?.balanceBaseUnits === null, simNope.json.funding);

    // --- E. sub-asset / unique simulations report their RVN fees ---
    const simSub = await req1.post('/v1/intents/simulate', {
      op: 'subasset', agentId: AGENT, assetName: 'FUNDCOIN/SIM', qty: '10', destination: address,
    });
    check('sub-asset simulate -> ALLOW with the 100 RVN fee funded',
      simSub.status === 200 && simSub.json.decision?.kind === 'ALLOW' &&
      simSub.json.funding?.requiredBaseUnits === '10000000000' && simSub.json.funding?.funded === true, simSub.json);
    const simUnique = await req1.post('/v1/intents/simulate', {
      op: 'unique', agentId: AGENT, assetName: 'FUNDCOIN#SIM1', destination: address,
    });
    check('unique simulate -> ALLOW with the 5 RVN fee funded',
      simUnique.status === 200 && simUnique.json.decision?.kind === 'ALLOW' &&
      simUnique.json.funding?.requiredBaseUnits === '500000000' && simUnique.json.funding?.funded === true, simUnique.json);

    // --- F. policy DENY / hold carry no funding object ---
    const simCap = await req1.post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'FUNDNEW2', qty: '500000', destination: address,
    });
    check('over-cap simulate -> DENY ISSUE_CAP_EXCEEDED with no funding object',
      simCap.status === 200 && simCap.json.decision?.kind === 'DENY' &&
      simCap.json.decision?.reasonCodes?.includes('ISSUE_CAP_EXCEEDED') &&
      simCap.json.funding === undefined, simCap.json);
    const simHold = await req1.post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'FUNDCOIN', qty: '100',
      destination: 'mtest1stranger000001xxxxxxxxxxxx',
    });
    check('hold simulate -> REQUIRE_APPROVAL with no funding object',
      simHold.status === 200 && simHold.json.decision?.kind === 'REQUIRE_APPROVAL' &&
      simHold.json.funding === undefined, simHold.json);

    // --- G. zero side effects from all the simulations ---
    check('simulations wrote no audit entries', (await lastSeq()) === seqAfterReal, {
      before: seqAfterReal, after: await lastSeq(),
    });
    check('no simulated intent is pending', (await req1.get('/v1/intents/pending')).pending.length === 0);
    const noAsset = await fetch(`${API1}/v1/assets/FUNDNEW`);
    check('simulated issue created no asset', noAsset.status === 404);
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
    check('policy updated for fund-agent on the low-RVN API', put2.status === 200);
    // Issue simulation: the 500 RVN fee exceeds the 100 RVN wallet.
    const simPoor = await req2.post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'POORNEW', qty: '10', destination: address,
    });
    check('low-RVN issue simulate -> DENY INSUFFICIENT_RVN_BALANCE',
      simPoor.status === 200 && simPoor.json.decision?.kind === 'DENY' &&
      simPoor.json.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE'), simPoor.json.decision);
    check('low-RVN funding object shows 100 RVN held vs 500 required',
      simPoor.json.funding?.funded === false && simPoor.json.funding?.balanceBaseUnits === '10000000000' &&
      simPoor.json.funding?.requiredBaseUnits === '50000000000', simPoor.json.funding);
    // Unique (5 RVN) still fits; reissue at exactly the balance (100 RVN) fits.
    const simUniquePoor = await req2.post('/v1/intents/simulate', {
      op: 'unique', agentId: AGENT, assetName: 'POORROOT#TAG1', destination: address,
    });
    check('low-RVN unique simulate -> ALLOW (5 RVN fee fits)',
      simUniquePoor.status === 200 && simUniquePoor.json.decision?.kind === 'ALLOW' &&
      simUniquePoor.json.funding?.funded === true, simUniquePoor.json);
    const simReissuePoor = await req2.post('/v1/intents/simulate', {
      op: 'reissue', agentId: AGENT, assetName: 'POORROOT', qty: '10', destination: address,
    });
    check('low-RVN reissue simulate -> ALLOW at exactly the 100 RVN balance',
      simReissuePoor.status === 200 && simReissuePoor.json.decision?.kind === 'ALLOW' &&
      simReissuePoor.json.funding?.balanceBaseUnits === '10000000000' &&
      simReissuePoor.json.funding?.requiredBaseUnits === '10000000000' &&
      simReissuePoor.json.funding?.funded === true, simReissuePoor.json);
    // The check and the execution agree — and since v0.37.0 the funding
    // gate refuses the doomed submit outright instead of letting it fail
    // at the node: a 403 DENY with the funding reason code, no asset,
    // and no EXECUTION_FAILED audit entry.
    const realPoor = await req2.post('/v1/assets/issue', {
      agentId: AGENT, name: 'POORNEW', qty: '10', toAddress: address,
    });
    check('low-RVN real issue is refused by the funding gate (403, not 502)',
      realPoor.status === 403 && realPoor.json?.decision?.kind === 'DENY' &&
      realPoor.json?.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE') &&
      realPoor.json?.funding?.funded === false, realPoor.json);
    const noAsset = await fetch(`${API2}/v1/assets/POORNEW`);
    check('failed low-RVN issue created no asset', noAsset.status === 404);
    const tail2 = await req2.get('/v1/audit?limit=50');
    const entries2 = tail2.entries as any[];
    check('no EXECUTION_FAILED entry for the gated issue',
      !entries2.some((e) => e.kind === 'EXECUTION_FAILED' && e.intentId === realPoor.json?.intent?.id), entries2.map((e) => e.kind));
    check('the gated issue was audited as a DECISION with the funding reason code',
      entries2.some((e) => e.kind === 'DECISION' && e.intentId === realPoor.json?.intent?.id &&
        (e.detail?.reasonCodes as string[])?.includes('INSUFFICIENT_RVN_BALANCE')),
      entries2.filter((e) => e.intentId === realPoor.json?.intent?.id));
  } finally {
    api2.kill();
  }

  console.log(failures ? `funding-test: FAILED (${failures})` : 'funding-test: all green');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
