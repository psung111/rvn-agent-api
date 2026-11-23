/**
 * funding-gate-test: checks for the funding gate on real submits (v0.37.0).
 *
 *  pnpm test:funding-gate
 *
 * The v0.36.0 funding check lived in simulate only: a real submit that
 * policy-ALLOWed but the wallet could not fund went to the node, failed
 * there, and landed as a 502 with an EXECUTION_FAILED audit entry. The
 * gate runs the same check before execution and turns the doomed ALLOW
 * into a DENY (INSUFFICIENT_ASSET_BALANCE / INSUFFICIENT_RVN_BALANCE,
 * audited as a decision, nothing executed) — and a hold that became
 * unfundable while it waited is caught at approval time, not at the node.
 *
 * Integration: boots two real APIs as child processes (MOCK_RVN=true):
 *   - API1 (default 1,000,000 RVN wallet): funded submits still execute;
 *     an over-balance transfer and a never-issued transfer are refused
 *     with 403 + the funding object, debit nothing, and are audited as
 *     decisions (no EXECUTION_FAILED); a funded hold still approves and
 *     executes; sub-asset / unique issues still execute.
 *   - API2 (100 RVN wallet, every issue held): approving a held issue
 *     is refused at approval time with 403 + INSUFFICIENT_RVN_BALANCE —
 *     the hold ends as a decision (audited with atApproval: true), no
 *     asset is created, and no EXECUTION_FAILED entry lands.
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3126;
const API2_PORT = 3127;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const AGENT = 'gate-agent';
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

function client(api: string) {
  return {
    post: async (path: string, body: unknown) => {
      const res = await fetch(`${api}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    },
    put: async (path: string, body: unknown) => {
      const res = await fetch(`${api}${path}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    },
    get: async (path: string) => (await (await fetch(`${api}${path}`)).json()) as any,
  };
}

async function main() {
  // ================= API1: funded wallet =================
  const api1 = await bootApi(API1_PORT);
  const req1 = client(API1);
  try {
    const health = await req1.get('/v1/health');
    check('API1 booted in mock mode', health.ok === true && health.mock === true);

    const { address } = (await req1.post('/v1/wallets', {})).json;
    const base = await req1.get(`/v1/policies/${AGENT}`);
    const putPolicy = await req1.put(`/v1/policies/${AGENT}`, {
      ...base, agentId: AGENT, allowedDestinations: [address], dailyIssueBudgetBaseUnits: '10000',
    });
    check('policy updated for gate-agent', putPolicy.status === 200);

    const auditFor = async (intentId: string) => {
      const tail = await req1.get('/v1/audit?limit=200');
      return (tail.entries as any[]).filter((e) => e.intentId === intentId);
    };

    // --- A. a funded issue still executes ---
    const issue = await req1.post('/v1/assets/issue', {
      agentId: AGENT, name: 'GATECOIN', qty: '600', toAddress: address,
    });
    check('funded issue executes (200 + txid)',
      issue.status === 200 && issue.json.decision?.kind === 'ALLOW' &&
      typeof issue.json.txid === 'string', issue.json);
    check('funded issue carries no funding object (the gate passed silently)',
      issue.json.funding === undefined, issue.json);

    // --- B. a funded transfer still executes ---
    const transfer = await req1.post('/v1/assets/transfer', {
      agentId: AGENT, assetName: 'GATECOIN', qty: '100', destination: address,
    });
    check('funded transfer executes (200 + txid)',
      transfer.status === 200 && transfer.json.decision?.kind === 'ALLOW' &&
      typeof transfer.json.txid === 'string', transfer.json);

    // --- C. an over-balance transfer is refused by the gate ---
    const over = await req1.post('/v1/assets/transfer', {
      agentId: AGENT, assetName: 'GATECOIN', qty: '601', destination: address,
    });
    check('over-balance transfer -> 403 DENY INSUFFICIENT_ASSET_BALANCE',
      over.status === 403 && over.json.decision?.kind === 'DENY' &&
      over.json.decision?.reasonCodes?.length === 1 &&
      over.json.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE'), over.json);
    check('over-balance 403 carries the funding object',
      over.json.funding?.asset === 'GATECOIN' && over.json.funding?.requiredBaseUnits === '601' &&
      over.json.funding?.balanceBaseUnits === '600' && over.json.funding?.funded === false,
      over.json.funding);
    const overEntries = await auditFor(over.json.intent?.id);
    check('gated transfer audited as a DECISION with the funding reason code',
      overEntries.some((e) => e.kind === 'DECISION' &&
        (e.detail?.reasonCodes as string[])?.includes('INSUFFICIENT_ASSET_BALANCE')), overEntries);
    check('no EXECUTION_FAILED entry for the gated transfer',
      !overEntries.some((e) => e.kind === 'EXECUTION_FAILED'), overEntries.map((e) => e.kind));
    const reApprove = await req1.post(`/v1/intents/${over.json.intent?.id}/approve`, { approver: 'paul' });
    check('gated transfer is not pending (approve -> 409)',
      reApprove.status === 409, reApprove.json);
    // The denied attempt debited nothing: the full 600 still transfers.
    const full = await req1.post('/v1/assets/transfer', {
      agentId: AGENT, assetName: 'GATECOIN', qty: '600', destination: address,
    });
    check('full balance still transfers after the gated attempt (nothing debited)',
      full.status === 200 && full.json.decision?.kind === 'ALLOW', full.json);

    // --- D. a transfer of a never-issued asset is refused the same way ---
    const nope = await req1.post('/v1/assets/transfer', {
      agentId: AGENT, assetName: 'NEVERISSUED', qty: '1', destination: address,
    });
    check('never-issued transfer -> 403 DENY INSUFFICIENT_ASSET_BALANCE, null balance',
      nope.status === 403 && nope.json.decision?.kind === 'DENY' &&
      nope.json.decision?.reasonCodes?.includes('INSUFFICIENT_ASSET_BALANCE') &&
      nope.json.funding?.funded === false && nope.json.funding?.balanceBaseUnits === null, nope.json);

    // --- E. a funded hold still approves and executes ---
    const hold = await req1.post('/v1/assets/transfer', {
      agentId: AGENT, assetName: 'GATECOIN', qty: '100', destination: STRANGER,
    });
    check('transfer to an unknown destination still holds (202)',
      hold.status === 202 && hold.json.decision?.kind === 'REQUIRE_APPROVAL', hold.json);
    const approved = await req1.post(`/v1/intents/${hold.json.intent?.id}/approve`, { approver: 'paul' });
    check('funded hold approves and executes (200 + txid)',
      approved.status === 200 && typeof approved.json.txid === 'string', approved.json);

    // --- F. funded sub-asset and unique issues still execute ---
    const sub = await req1.post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'GATECOIN/SUB', qty: '10', toAddress: address,
    });
    check('funded sub-asset issue executes',
      sub.status === 200 && sub.json.decision?.kind === 'ALLOW', sub.json);
    const unique = await req1.post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'GATECOIN#TAG1', toAddress: address,
    });
    check('funded unique issue executes',
      unique.status === 200 && unique.json.decision?.kind === 'ALLOW', unique.json);

    const audit1 = await req1.get('/v1/audit?limit=5');
    check('API1 audit chain valid', audit1.chainValid === true);
  } finally {
    api1.kill();
  }

  // ================= API2: poor wallet, every issue held =================
  const api2 = await bootApi(API2_PORT, { MOCK_RVN_BALANCE_BASE_UNITS: '10000000000' });
  const req2 = client(API2);
  try {
    const { address } = (await req2.post('/v1/wallets', {})).json;
    const base2 = await req2.get(`/v1/policies/${AGENT}`);
    const put2 = await req2.put(`/v1/policies/${AGENT}`, {
      ...base2, agentId: AGENT, allowedDestinations: [address],
      approvalAboveIssueQtyBaseUnits: '0',
    });
    check('policy updated for gate-agent on the low-RVN API (every issue holds)', put2.status === 200);

    // --- G. the issue holds at submit time (the gate runs only on ALLOW) ---
    const heldIssue = await req2.post('/v1/assets/issue', {
      agentId: AGENT, name: 'POORGATE', qty: '10', toAddress: address,
    });
    check('low-RVN issue holds at submit (202, no funding object yet)',
      heldIssue.status === 202 && heldIssue.json.decision?.kind === 'REQUIRE_APPROVAL' &&
      heldIssue.json.funding === undefined, heldIssue.json);

    // --- H. approving the held issue is refused at approval time ---
    const approvePoor = await req2.post(`/v1/intents/${heldIssue.json.intent?.id}/approve`, { approver: 'paul' });
    check('approving an unfundable held issue -> 403 DENY INSUFFICIENT_RVN_BALANCE',
      approvePoor.status === 403 && approvePoor.json.decision?.kind === 'DENY' &&
      approvePoor.json.decision?.reasonCodes?.length === 1 &&
      approvePoor.json.decision?.reasonCodes?.includes('INSUFFICIENT_RVN_BALANCE'), approvePoor.json);
    check('approval-time 403 carries the funding object (100 RVN held vs 500 RVN + miner fee required)',
      approvePoor.json.funding?.asset === 'RVN' &&
      approvePoor.json.funding?.requiredBaseUnits === '50000005000' &&
      approvePoor.json.funding?.balanceBaseUnits === '10000000000' &&
      approvePoor.json.funding?.funded === false, approvePoor.json.funding);
    check('approval-time funding deny carries no txid and no node error',
      approvePoor.json.txid === undefined && approvePoor.json.error !== undefined &&
      /funding check/.test(approvePoor.json.error), approvePoor.json);
    const tail2 = await req2.get('/v1/audit?limit=200');
    const entries2 = (tail2.entries as any[]).filter((e) => e.intentId === heldIssue.json.intent?.id);
    check('approval-time funding deny audited as a DECISION with atApproval: true',
      entries2.some((e) => e.kind === 'DECISION' && e.detail?.atApproval === true &&
        (e.detail?.reasonCodes as string[])?.includes('INSUFFICIENT_RVN_BALANCE')), entries2);
    check('no EXECUTION_FAILED entry for the approval-time gated issue',
      !entries2.some((e) => e.kind === 'EXECUTION_FAILED'), entries2.map((e) => e.kind));
    const reApprove2 = await req2.post(`/v1/intents/${heldIssue.json.intent?.id}/approve`, { approver: 'paul' });
    check('funding-denied hold is not pending (approve -> 409)',
      reApprove2.status === 409, reApprove2.json);
    const noAsset = await fetch(`${API2}/v1/assets/POORGATE`);
    check('funding-denied issue created no asset', noAsset.status === 404);
    check('API2 audit chain valid', tail2.chainValid === true);
  } finally {
    api2.kill();
  }

  console.log(failures ? `funding-gate-test: FAILED (${failures})` : 'funding-gate-test: all green');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
