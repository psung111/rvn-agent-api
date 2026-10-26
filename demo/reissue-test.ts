/**
 * reissue-test: checks for the POST /v1/assets/reissue policy-gated flow.
 *
 *  pnpm test:reissue
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - reissue of an existing asset ALLOWs and grows its supply
 *   - reissue shares the issue policy dimensions: per-op cap, 24h issue
 *     budget, approval threshold, destination allowlist, name pattern
 *   - reissue spend counts against the agent's 24h issue budget
 *   - held reissues approve/deny through the normal resolution path, and
 *     execParams (newUnits/newIpfsHash) survive the hold
 *   - unknown asset / non-reissuable asset -> 502 (policy ALLOWed, node failed)
 *   - invalid bodies -> 400; op:'reissue' works in simulate with zero side effects
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3124;
const API = `http://127.0.0.1:${API_PORT}`;
const AGENT = 'reissue-agent';
const DENY_AGENT = 'reissue-deny-agent';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function bootApi(): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(API_PORT), MOCK_RVN: 'true' },
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

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function put(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path: string) {
  return (await (await fetch(`${API}${path}`)).json()) as any;
}

async function main() {
  const api = await bootApi();
  try {
    const health = await get('/v1/health');
    check('API booted in mock mode', health.ok === true && health.mock === true);

    const walletA = (await post('/v1/wallets', {})).json.address as string;
    const walletB = (await post('/v1/wallets', {})).json.address as string;
    check('provisioned two wallets', typeof walletA === 'string' && typeof walletB === 'string' && walletA !== walletB);

    // Tighten policy for reissue-agent: allowlist walletA, 24h issue budget 1000.
    const base = await get('/v1/policies/reissue-agent');
    const policyRes = await put('/v1/policies/reissue-agent', {
      ...base, agentId: AGENT, allowedDestinations: [walletA], dailyIssueBudgetBaseUnits: '1000',
    });
    check('policy set for reissue-agent', policyRes.status === 200);

    const assetData = async (name: string) => get(`/v1/assets/${name}`);
    const lastSeq = async (): Promise<number> => {
      const tail = await get('/v1/audit?limit=1');
      return tail.entries.length ? tail.entries[0].seq : 0;
    };

    // --- 1. issue the asset we will reissue ---
    const i1 = await post('/v1/assets/issue', {
      agentId: AGENT, name: 'REICOIN1', qty: '500', toAddress: walletA,
    });
    check('issue REICOIN1 -> ALLOW (200)', i1.status === 200 && i1.json.decision?.kind === 'ALLOW', i1.json);
    check('issue returns a txid', typeof i1.json.txid === 'string' && i1.json.txid.length > 0);
    const a1 = await assetData('REICOIN1');
    check('asset amount is 500', a1.amount === '500', a1);
    check('asset is reissuable', a1.reissuable === true);

    // --- 2. plain reissue grows the supply ---
    const r1 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '300', toAddress: walletA,
    });
    check('reissue 300 -> ALLOW (200)', r1.status === 200 && r1.json.decision?.kind === 'ALLOW', r1.json);
    check('reissue returns a txid', typeof r1.json.txid === 'string' && r1.json.txid.length > 0);
    check('intent kind is reissue_asset', r1.json.intent?.kind === 'reissue_asset');
    const a2 = await assetData('REICOIN1');
    check('asset amount grew to 800', a2.amount === '800', a2);

    // --- 3. reissue with newUnits + newIpfsHash ---
    const r2 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '100', toAddress: walletA,
      newUnits: 2, newIpfsHash: 'QmReissueTestHash',
    });
    check('reissue with extras -> ALLOW (200)', r2.status === 200 && r2.json.decision?.kind === 'ALLOW', r2.json);
    const a3 = await assetData('REICOIN1');
    check('units replaced to 2', a3.units === 2, a3);
    check('ipfs hash replaced', a3.ipfsHash === 'QmReissueTestHash', a3);
    check('amount grew to 900', a3.amount === '900', a3);

    // --- 4. unknown asset: policy ALLOWs, node fails -> 502 ---
    const r3 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'NOSUCHASSET', qty: '50', toAddress: walletA,
    });
    check('reissue unknown asset -> 502', r3.status === 502, r3.json);
    check('502 error names the asset', /unknown asset/i.test(r3.json.error ?? ''), r3.json);

    // --- 5. policy dimensions: per-op cap and shared 24h budget ---
    const r4 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '100001', toAddress: walletA,
    });
    check('reissue over per-op cap -> 403', r4.status === 403, r4.json);
    check('cap deny carries ISSUE_CAP_EXCEEDED', r4.json.decision?.reasonCodes?.includes('ISSUE_CAP_EXCEEDED'));
    // Ledger: 500 + 300 + 100 = 900 spent of 1000.
    const r5 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '200', toAddress: walletA,
    });
    check('reissue over 24h budget -> 403', r5.status === 403, r5.json);
    check('budget deny carries DAILY_ISSUE_BUDGET_EXCEEDED',
      r5.json.decision?.reasonCodes?.includes('DAILY_ISSUE_BUDGET_EXCEEDED'));

    // --- 6. hold flow: unknown destination -> 202, approve executes ---
    const r6 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '50', toAddress: walletB,
    });
    check('reissue to unknown dest -> 202 hold', r6.status === 202 && r6.json.decision?.kind === 'REQUIRE_APPROVAL', r6.json);
    check('hold carries DESTINATION_NOT_ALLOWLISTED',
      r6.json.decision?.reasonCodes?.includes('DESTINATION_NOT_ALLOWLISTED'));
    const holdId: string = r6.json.intent.id;
    const ap1 = await post(`/v1/intents/${holdId}/approve`, { approver: 'reissue-test' });
    check('approve executes the reissue (200)', ap1.status === 200 && typeof ap1.json.txid === 'string', ap1.json);
    const a4 = await assetData('REICOIN1');
    check('amount grew to 950 after approval', a4.amount === '950', a4);
    const ap2 = await post(`/v1/intents/${holdId}/approve`, { approver: 'reissue-test' });
    check('re-approve returns 409', ap2.status === 409, ap2.json);

    // --- 7. execParams survive the hold: tighten the threshold, reissue with newUnits ---
    const tight = await put('/v1/policies/reissue-agent', {
      ...base, agentId: AGENT, allowedDestinations: [walletA],
      dailyIssueBudgetBaseUnits: '1000', approvalAboveIssueQtyBaseUnits: '10',
    });
    check('threshold tightened', tight.status === 200);
    const r7 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '50', toAddress: walletA, newUnits: 4,
    });
    check('reissue above threshold -> 202 hold', r7.status === 202 && r7.json.decision?.kind === 'REQUIRE_APPROVAL', r7.json);
    const ap3 = await post(`/v1/intents/${r7.json.intent.id}/approve`, { approver: 'reissue-test' });
    check('approve of held reissue with newUnits -> 200', ap3.status === 200, ap3.json);
    const a5 = await assetData('REICOIN1');
    check('newUnits replayed at approval (units 4)', a5.units === 4, a5);
    check('amount grew to 1000 after second approval', a5.amount === '1000', a5);

    // --- 8. deny flow on a separate agent (fresh budget) ---
    const denyBase = await get('/v1/policies/reissue-deny-agent');
    const denyPolicy = await put('/v1/policies/reissue-deny-agent', {
      ...denyBase, agentId: DENY_AGENT, allowedDestinations: [walletA],
      approvalAboveIssueQtyBaseUnits: '10',
    });
    check('policy set for deny agent', denyPolicy.status === 200);
    const r8 = await post('/v1/assets/reissue', {
      agentId: DENY_AGENT, name: 'REICOIN1', qty: '50', toAddress: walletA,
    });
    check('deny-agent reissue held (202)', r8.status === 202, r8.json);
    const dn1 = await post(`/v1/intents/${r8.json.intent.id}/deny`, { approver: 'reissue-test' });
    check('deny returns denied:true', dn1.status === 200 && dn1.json.denied === true, dn1.json);
    const ap4 = await post(`/v1/intents/${r8.json.intent.id}/approve`, { approver: 'reissue-test' });
    check('approving a denied reissue returns 409', ap4.status === 409, ap4.json);

    // --- 9. non-reissuable asset: policy ALLOWs, node fails -> 502 ---
    const f1 = await post('/v1/assets/issue', {
      agentId: DENY_AGENT, name: 'FIXEDCOIN', qty: '100', toAddress: walletA, reissuable: false,
    });
    check('FIXEDCOIN issue held (202, above threshold)', f1.status === 202, f1.json);
    const f1a = await post(`/v1/intents/${f1.json.intent.id}/approve`, { approver: 'reissue-test' });
    check('FIXEDCOIN issue approved (200)', f1a.status === 200, f1a.json);
    const fx = await assetData('FIXEDCOIN');
    check('FIXEDCOIN is non-reissuable', fx.reissuable === false, fx);
    const f2 = await post('/v1/assets/reissue', {
      agentId: DENY_AGENT, name: 'FIXEDCOIN', qty: '10', toAddress: walletA,
    });
    check('reissue non-reissuable asset -> 502', f2.status === 502, f2.json);
    check('502 error names non-reissuable', /not reissuable/i.test(f2.json.error ?? ''), f2.json);

    // --- 10. bad bodies -> 400 ---
    const b1 = await post('/v1/assets/reissue', { agentId: AGENT, qty: '10', toAddress: walletA });
    check('missing name -> 400', b1.status === 400, b1.json);
    const b2 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '10', toAddress: walletA, newUnits: 9,
    });
    check('newUnits 9 -> 400', b2.status === 400, b2.json);
    const b3 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'REICOIN1', qty: '10', toAddress: walletA, newIpfsHash: 'QmX',
    });
    check('newIpfsHash without newUnits -> 400', b3.status === 400, b3.json);

    // --- 11. simulate op:'reissue' has zero side effects ---
    const seqBefore = await lastSeq();
    const s1 = await post('/v1/intents/simulate', {
      op: 'reissue', agentId: DENY_AGENT, assetName: 'REICOIN1', qty: '5', destination: walletA,
    });
    check('simulate reissue -> 200', s1.status === 200, s1.json);
    check('simulate flags simulated:true', s1.json.simulated === true);
    check('simulate reissue decision is ALLOW', s1.json.decision?.kind === 'ALLOW', s1.json.decision);
    check('audit seq unchanged by simulation', (await lastSeq()) === seqBefore);
    const pending = await get('/v1/intents/pending');
    check('simulation created no pending intent',
      !pending.pending.some((p: any) => String(p.intent.id).startsWith('sim-')));
    const s2 = await post('/v1/intents/simulate', {
      op: 'reissue', agentId: DENY_AGENT, assetName: 'REICOIN1', qty: '999999', destination: walletA,
    });
    check('simulate over-cap reissue -> DENY', s2.json.decision?.kind === 'DENY', s2.json.decision);

    // --- 12. chain + listing ---
    const audit = await get('/v1/audit?limit=200');
    check('audit chain is valid', audit.chainValid === true);
    const list = await get('/v1/assets?pattern=REICOIN1');
    check('asset listing includes REICOIN1', Array.isArray(list.assets) && list.assets.some((a: any) => a.name === 'REICOIN1'), list);
  } finally {
    api.kill();
  }
  console.log(failures ? `reissue-test: ${failures} FAILURES` : 'reissue-test: all green');
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
