/**
 * subasset-test: checks for the POST /v1/assets/issue-subasset policy-gated flow.
 *
 *  pnpm test:subasset
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - sub-asset issuance under an existing parent ALLOWs and creates the asset
 *   - nested sub-assets (PARENT/CHILD/GRAND) work when the immediate parent exists
 *   - the asset-name pattern is applied per slash-separated segment
 *   - sub-assets share the issue policy dimensions: per-op cap, 24h issue
 *     budget, approval threshold, destination allowlist
 *   - sub-asset spend counts against the agent's 24h issue budget
 *   - held sub-assets approve/deny through the normal resolution path, and
 *     execParams (units/ipfsHash) survive the hold
 *   - unknown parent / duplicate name -> 502 (policy ALLOWed, node failed)
 *   - a name without '/' -> 400; op:'subasset' works in simulate with zero side effects
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3125;
const API = `http://127.0.0.1:${API_PORT}`;
const AGENT = 'subasset-agent';
const HOLD_AGENT = 'subasset-hold-agent';
const DENY_AGENT = 'subasset-deny-agent';

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
  const res = await fetch(`${API}${path}`);
  return (await res.json()) as any;
}

async function main() {
  const api = await bootApi();
  try {
    const health = await get('/v1/health');
    check('API booted in mock mode', health.ok === true && health.mock === true);

    const walletA = (await post('/v1/wallets', {})).json.address as string;
    const walletB = (await post('/v1/wallets', {})).json.address as string;
    check('provisioned two wallets', typeof walletA === 'string' && typeof walletB === 'string' && walletA !== walletB);

    // Tighten policy for subasset-agent: allowlist walletA, 24h issue budget 1000.
    const base = await get('/v1/policies/subasset-agent');
    const policyRes = await put('/v1/policies/subasset-agent', {
      ...base, agentId: AGENT, allowedDestinations: [walletA], dailyIssueBudgetBaseUnits: '1000',
    });
    check('policy set for subasset-agent', policyRes.status === 200);

    const assetData = async (name: string) => get(`/v1/assets/${encodeURIComponent(name)}`);
    const lastSeq = async (): Promise<number> => {
      const tail = await get('/v1/audit?limit=1');
      return tail.entries.length ? tail.entries[0].seq : 0;
    };

    // --- 1. issue the parent asset ---
    const p1 = await post('/v1/assets/issue', {
      agentId: AGENT, name: 'PARENT1', qty: '500', toAddress: walletA,
    });
    check('issue PARENT1 -> ALLOW (200)', p1.status === 200 && p1.json.decision?.kind === 'ALLOW', p1.json);
    const pa = await assetData('PARENT1');
    check('parent amount is 500', pa.amount === '500', pa);

    // --- 2. plain sub-asset issuance ---
    const s1 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/CHILD', qty: '300', toAddress: walletA,
    });
    check('sub-asset PARENT1/CHILD -> ALLOW (200)', s1.status === 200 && s1.json.decision?.kind === 'ALLOW', s1.json);
    check('intent kind is issue_subasset', s1.json.intent?.kind === 'issue_subasset');
    check('sub-asset returns a txid', typeof s1.json.txid === 'string' && s1.json.txid.length > 0);
    const c1 = await assetData('PARENT1/CHILD');
    check('sub-asset amount is 300', c1.amount === '300', c1);
    check('sub-asset is reissuable by default', c1.reissuable === true);
    const pa2 = await assetData('PARENT1');
    check('parent amount unchanged at 500', pa2.amount === '500', pa2);

    // --- 3. sub-asset with units + ipfsHash ---
    const s2 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/REWARD', qty: '50', toAddress: walletA,
      units: 2, ipfsHash: 'QmSubAssetTest',
    });
    check('sub-asset with extras -> ALLOW (200)', s2.status === 200 && s2.json.decision?.kind === 'ALLOW', s2.json);
    const r1 = await assetData('PARENT1/REWARD');
    check('units applied (2)', r1.units === 2, r1);
    check('ipfs hash applied', r1.ipfsHash === 'QmSubAssetTest', r1);
    check('amount is 50', r1.amount === '50', r1);

    // --- 4. nested sub-asset: immediate parent PARENT1/CHILD exists ---
    const s3 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/CHILD/GRAND', qty: '100', toAddress: walletA,
    });
    check('nested sub-asset -> ALLOW (200)', s3.status === 200 && s3.json.decision?.kind === 'ALLOW', s3.json);
    const g1 = await assetData('PARENT1/CHILD/GRAND');
    check('nested sub-asset amount is 100', g1.amount === '100', g1);

    // --- 5. unknown parent: policy ALLOWs, node fails -> 502 ---
    const s4 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'NOSUCH/CHILD', qty: '50', toAddress: walletA,
    });
    check('sub-asset under unknown parent -> 502', s4.status === 502, s4.json);
    check('502 error names the unknown parent', /unknown parent/i.test(s4.json.error ?? ''), s4.json);

    // --- 6. name without '/' -> 400 ---
    const s5 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1', qty: '50', toAddress: walletA,
    });
    check('name without slash -> 400', s5.status === 400, s5.json);

    // --- 7. short segment fails the per-segment name pattern -> 403 ---
    const s6 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/AB', qty: '50', toAddress: walletA,
    });
    check('short segment -> 403', s6.status === 403, s6.json);
    check('short-segment deny carries ASSET_NAME_REJECTED',
      s6.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));

    // --- 8. duplicate sub-asset name -> 502 ---
    const s7 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/CHILD', qty: '50', toAddress: walletA,
    });
    check('duplicate sub-asset -> 502', s7.status === 502, s7.json);
    check('502 error names already exists', /already exists/i.test(s7.json.error ?? ''), s7.json);

    // --- 9. policy dimensions: per-op cap and shared 24h budget ---
    const s8 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/EXTRA', qty: '100001', toAddress: walletA,
    });
    check('sub-asset over per-op cap -> 403', s8.status === 403, s8.json);
    check('cap deny carries ISSUE_CAP_EXCEEDED', s8.json.decision?.reasonCodes?.includes('ISSUE_CAP_EXCEEDED'));
    // Ledger: 500 + 300 + 50 + 100 = 950 spent of 1000.
    const s9 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/EXTRA', qty: '100', toAddress: walletA,
    });
    check('sub-asset over 24h budget -> 403', s9.status === 403, s9.json);
    check('budget deny carries DAILY_ISSUE_BUDGET_EXCEEDED',
      s9.json.decision?.reasonCodes?.includes('DAILY_ISSUE_BUDGET_EXCEEDED'));

    // --- 10. hold flow: unknown destination -> 202, approve executes ---
    const s10 = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'PARENT1/EXTRA', qty: '50', toAddress: walletB,
    });
    check('sub-asset to unknown dest -> 202 hold', s10.status === 202 && s10.json.decision?.kind === 'REQUIRE_APPROVAL', s10.json);
    check('hold carries DESTINATION_NOT_ALLOWLISTED',
      s10.json.decision?.reasonCodes?.includes('DESTINATION_NOT_ALLOWLISTED'));
    const ap1 = await post(`/v1/intents/${s10.json.intent.id}/approve`, { approver: 'subasset-test' });
    check('approve executes the sub-asset (200)', ap1.status === 200 && typeof ap1.json.txid === 'string', ap1.json);
    const e1 = await assetData('PARENT1/EXTRA');
    check('approved sub-asset amount is 50', e1.amount === '50', e1);
    const ap2 = await post(`/v1/intents/${s10.json.intent.id}/approve`, { approver: 'subasset-test' });
    check('re-approve returns 409', ap2.status === 409, ap2.json);

    // --- 11. execParams survive the hold (fresh-budget agent, tight threshold) ---
    const holdBase = await get('/v1/policies/subasset-hold-agent');
    const holdPolicy = await put('/v1/policies/subasset-hold-agent', {
      ...holdBase, agentId: HOLD_AGENT, allowedDestinations: [walletA],
      approvalAboveIssueQtyBaseUnits: '10',
    });
    check('policy set for hold agent', holdPolicy.status === 200);
    const s11 = await post('/v1/assets/issue-subasset', {
      agentId: HOLD_AGENT, name: 'PARENT1/HELD', qty: '20', toAddress: walletA, units: 3,
    });
    check('sub-asset above threshold -> 202 hold', s11.status === 202 && s11.json.decision?.kind === 'REQUIRE_APPROVAL', s11.json);
    const ap3 = await post(`/v1/intents/${s11.json.intent.id}/approve`, { approver: 'subasset-test' });
    check('approve of held sub-asset with units -> 200', ap3.status === 200, ap3.json);
    const h1 = await assetData('PARENT1/HELD');
    check('units replayed at approval (units 3)', h1.units === 3, h1);
    check('held sub-asset amount is 20', h1.amount === '20', h1);

    // --- 12. deny flow on a separate agent ---
    const denyBase = await get('/v1/policies/subasset-deny-agent');
    const denyPolicy = await put('/v1/policies/subasset-deny-agent', {
      ...denyBase, agentId: DENY_AGENT, allowedDestinations: [walletA],
      approvalAboveIssueQtyBaseUnits: '10',
    });
    check('policy set for deny agent', denyPolicy.status === 200);
    const s12 = await post('/v1/assets/issue-subasset', {
      agentId: DENY_AGENT, name: 'PARENT1/DENIED', qty: '20', toAddress: walletA,
    });
    check('deny-agent sub-asset held (202)', s12.status === 202, s12.json);
    const dn1 = await post(`/v1/intents/${s12.json.intent.id}/deny`, { approver: 'subasset-test' });
    check('deny returns denied:true', dn1.status === 200 && dn1.json.denied === true, dn1.json);
    const ap4 = await post(`/v1/intents/${s12.json.intent.id}/approve`, { approver: 'subasset-test' });
    check('approving a denied sub-asset returns 409', ap4.status === 409, ap4.json);
    const deniedAsset = await get(`/v1/assets/${encodeURIComponent('PARENT1/DENIED')}`);
    check('denied sub-asset was never created (404)', deniedAsset.error === 'unknown asset', deniedAsset);

    // --- 13. simulate op:'subasset' has zero side effects ---
    const seqBefore = await lastSeq();
    const sim1 = await post('/v1/intents/simulate', {
      op: 'subasset', agentId: DENY_AGENT, assetName: 'PARENT1/SIM', qty: '5', destination: walletA,
    });
    check('simulate subasset -> 200', sim1.status === 200, sim1.json);
    check('simulate flags simulated:true', sim1.json.simulated === true);
    check('simulate subasset decision is ALLOW', sim1.json.decision?.kind === 'ALLOW', sim1.json.decision);
    const sim2 = await post('/v1/intents/simulate', {
      op: 'subasset', agentId: DENY_AGENT, assetName: 'PARENT1', qty: '5', destination: walletA,
    });
    check('simulate subasset without slash -> DENY', sim2.json.decision?.kind === 'DENY', sim2.json.decision);
    check('no-slash simulate carries ASSET_NAME_REJECTED',
      sim2.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));
    check('audit seq unchanged by simulation', (await lastSeq()) === seqBefore);
    const pending = await get('/v1/intents/pending');
    check('simulation created no pending intent',
      !pending.pending.some((p: any) => String(p.intent.id).startsWith('sim-')));
    const sim3 = await post('/v1/intents/simulate', {
      op: 'subasset', agentId: DENY_AGENT, assetName: 'PARENT1/SIM', qty: '999999', destination: walletA,
    });
    check('simulate over-cap subasset -> DENY', sim3.json.decision?.kind === 'DENY', sim3.json.decision);

    // --- 14. chain + listing ---
    const audit = await get('/v1/audit?limit=200');
    check('audit chain is valid', audit.chainValid === true);
    const list = await get('/v1/assets?pattern=PARENT1*');
    check('asset listing includes sub-assets',
      Array.isArray(list.assets) && list.assets.some((a: any) => a.name === 'PARENT1/CHILD'), list);
  } finally {
    api.kill();
  }
  console.log(failures ? `subasset-test: ${failures} FAILURES` : 'subasset-test: all green');
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
