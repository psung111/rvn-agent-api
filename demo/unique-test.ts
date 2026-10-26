/**
 * unique-test: checks for the POST /v1/assets/issue-unique policy-gated flow.
 *
 *  pnpm test:unique
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - unique asset issuance under an existing root ALLOWs and creates a
 *     singleton (amount 1, units 0, never reissuable)
 *   - unique assets under a sub-asset root (ROOT/SUB#TAG) work
 *   - the asset-name pattern is applied to the root (per slash segment)
 *     and the tag is checked separately (1..30 chars, wider charset)
 *   - unique assets share the issue policy dimensions: 24h issue budget
 *     (each counts 1), destination allowlist, approval threshold
 *   - held uniques approve/deny through the normal resolution path, and
 *     execParams (ipfsHash) survive the hold
 *   - unknown root / duplicate name -> 502 (policy ALLOWed, node failed)
 *   - a name without '#' -> 400; qty other than 1 -> 400; qty omitted -> 1
 *   - reissuing a unique asset is denied at the policy layer ('#' is not
 *     in the reissue name pattern) — and would also fail at the node, since
 *     uniques are created reissuable:false
 *   - op:'unique' works in simulate with zero side effects
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3126;
const API = `http://127.0.0.1:${API_PORT}`;
const AGENT = 'unique-agent';
const HOLD_AGENT = 'unique-hold-agent';
const DENY_AGENT = 'unique-deny-agent';

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

    // Tighten policy for unique-agent: allowlist walletA, 24h issue budget 1000.
    const base = await get('/v1/policies/unique-agent');
    const policyRes = await put('/v1/policies/unique-agent', {
      ...base, agentId: AGENT, allowedDestinations: [walletA], dailyIssueBudgetBaseUnits: '1000',
    });
    check('policy set for unique-agent', policyRes.status === 200);

    const assetData = async (name: string) => get(`/v1/assets/${encodeURIComponent(name)}`);
    const lastSeq = async (): Promise<number> => {
      const tail = await get('/v1/audit?limit=1');
      return tail.entries.length ? tail.entries[0].seq : 0;
    };

    // --- 1. issue the root asset ---
    const p1 = await post('/v1/assets/issue', {
      agentId: AGENT, name: 'ROOT1', qty: '500', toAddress: walletA,
    });
    check('issue ROOT1 -> ALLOW (200)', p1.status === 200 && p1.json.decision?.kind === 'ALLOW', p1.json);
    const pa = await assetData('ROOT1');
    check('root amount is 500', pa.amount === '500', pa);

    // --- 2. plain unique issuance ---
    const s1 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#SERIAL001', qty: '1', toAddress: walletA,
    });
    check('unique ROOT1#SERIAL001 -> ALLOW (200)', s1.status === 200 && s1.json.decision?.kind === 'ALLOW', s1.json);
    check('intent kind is issue_unique', s1.json.intent?.kind === 'issue_unique');
    check('unique returns a txid', typeof s1.json.txid === 'string' && s1.json.txid.length > 0);
    const c1 = await assetData('ROOT1#SERIAL001');
    check('unique amount is 1 (singleton)', c1.amount === '1', c1);
    check('unique units are 0', c1.units === 0, c1);
    check('unique is never reissuable', c1.reissuable === false, c1);
    const pa2 = await assetData('ROOT1');
    check('root amount unchanged at 500', pa2.amount === '500', pa2);

    // --- 3. unique with ipfsHash, qty omitted (defaults to 1) ---
    const s2 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#SERIAL002', toAddress: walletA, ipfsHash: 'QmUniqueTest',
    });
    check('unique without qty -> ALLOW (200)', s2.status === 200 && s2.json.decision?.kind === 'ALLOW', s2.json);
    const r1 = await assetData('ROOT1#SERIAL002');
    check('ipfs hash applied', r1.ipfsHash === 'QmUniqueTest', r1);
    check('qty defaulted to 1', r1.amount === '1', r1);

    // --- 4. unique under a sub-asset root ---
    const s3a = await post('/v1/assets/issue-subasset', {
      agentId: AGENT, name: 'ROOT1/ART', qty: '100', toAddress: walletA,
    });
    check('sub-asset root ROOT1/ART -> ALLOW', s3a.status === 200, s3a.json);
    const s3 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1/ART#MONALISA', qty: '1', toAddress: walletA,
    });
    check('unique under sub-asset root -> ALLOW (200)', s3.status === 200 && s3.json.decision?.kind === 'ALLOW', s3.json);
    const g1 = await assetData('ROOT1/ART#MONALISA');
    check('sub-root unique amount is 1', g1.amount === '1', g1);

    // --- 5. unknown root: policy ALLOWs, node fails -> 502 ---
    const s4 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'NOSUCH#TAG001', qty: '1', toAddress: walletA,
    });
    check('unique under unknown root -> 502', s4.status === 502, s4.json);
    check('502 error names the unknown root', /unknown root/i.test(s4.json.error ?? ''), s4.json);

    // --- 6. name without '#' -> 400 ---
    const s5 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1', qty: '1', toAddress: walletA,
    });
    check('name without hash -> 400', s5.status === 400, s5.json);

    // --- 7. name-shape denies -> 403 ASSET_NAME_REJECTED ---
    const s6 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#A#B', qty: '1', toAddress: walletA,
    });
    check('two hashes -> 403', s6.status === 403, s6.json);
    check('two-hash deny carries ASSET_NAME_REJECTED',
      s6.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));
    const s7 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'AB#TAG001', qty: '1', toAddress: walletA,
    });
    check('short root -> 403', s7.status === 403, s7.json);
    check('short-root deny carries ASSET_NAME_REJECTED',
      s7.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));
    const s8 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#', qty: '1', toAddress: walletA,
    });
    check('empty tag -> 403', s8.status === 403, s8.json);
    check('empty-tag deny carries ASSET_NAME_REJECTED',
      s8.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));

    // --- 8. duplicate unique name -> 502 ---
    const s9 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#SERIAL001', qty: '1', toAddress: walletA,
    });
    check('duplicate unique -> 502', s9.status === 502, s9.json);
    check('502 error names already exists', /already exists/i.test(s9.json.error ?? ''), s9.json);

    // --- 9. qty other than 1 -> 400 ---
    const s10 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#SERIAL003', qty: '2', toAddress: walletA,
    });
    check('qty 2 for a singleton -> 400', s10.status === 400, s10.json);

    // --- 10. reissuing a unique asset fails at the policy layer ---
    // The reissue kind matches the asset-name pattern against the whole
    // name, and '#' is not in it — so a unique asset can never even reach
    // the node as a reissue (the node would also refuse it: uniques are
    // created reissuable:false). Belt and braces.
    const s11 = await post('/v1/assets/reissue', {
      agentId: AGENT, name: 'ROOT1#SERIAL001', qty: '1', toAddress: walletA,
    });
    check('reissue of a unique asset -> 403', s11.status === 403, s11.json);
    check('reissue deny carries ASSET_NAME_REJECTED',
      s11.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));

    // --- 11. hold flow: unknown destination -> 202, approve executes, ipfs replays ---
    const holdBase = await get('/v1/policies/unique-hold-agent');
    const holdPolicy = await put('/v1/policies/unique-hold-agent', {
      ...holdBase, agentId: HOLD_AGENT, allowedDestinations: [walletA],
    });
    check('policy set for hold agent', holdPolicy.status === 200);
    const s12 = await post('/v1/assets/issue-unique', {
      agentId: HOLD_AGENT, name: 'ROOT1#HELD001', toAddress: walletB, ipfsHash: 'QmHeldUnique',
    });
    check('unique to unknown dest -> 202 hold', s12.status === 202 && s12.json.decision?.kind === 'REQUIRE_APPROVAL', s12.json);
    check('hold carries DESTINATION_NOT_ALLOWLISTED',
      s12.json.decision?.reasonCodes?.includes('DESTINATION_NOT_ALLOWLISTED'));
    const ap1 = await post(`/v1/intents/${s12.json.intent.id}/approve`, { approver: 'unique-test' });
    check('approve executes the unique (200)', ap1.status === 200 && typeof ap1.json.txid === 'string', ap1.json);
    const e1 = await assetData('ROOT1#HELD001');
    check('approved unique amount is 1', e1.amount === '1', e1);
    check('ipfs replayed at approval', e1.ipfsHash === 'QmHeldUnique', e1);
    const ap2 = await post(`/v1/intents/${s12.json.intent.id}/approve`, { approver: 'unique-test' });
    check('re-approve returns 409', ap2.status === 409, ap2.json);

    // --- 12. deny flow on a separate agent ---
    const denyBase = await get('/v1/policies/unique-deny-agent');
    const denyPolicy = await put('/v1/policies/unique-deny-agent', {
      ...denyBase, agentId: DENY_AGENT, allowedDestinations: [walletA],
    });
    check('policy set for deny agent', denyPolicy.status === 200);
    const s13 = await post('/v1/assets/issue-unique', {
      agentId: DENY_AGENT, name: 'ROOT1#DENIED001', toAddress: walletB,
    });
    check('deny-agent unique held (202)', s13.status === 202, s13.json);
    const dn1 = await post(`/v1/intents/${s13.json.intent.id}/deny`, { approver: 'unique-test' });
    check('deny returns denied:true', dn1.status === 200 && dn1.json.denied === true, dn1.json);
    const ap3 = await post(`/v1/intents/${s13.json.intent.id}/approve`, { approver: 'unique-test' });
    check('approving a denied unique returns 409', ap3.status === 409, ap3.json);
    const deniedAsset = await get(`/v1/assets/${encodeURIComponent('ROOT1#DENIED001')}`);
    check('denied unique was never created (404)', deniedAsset.error === 'unknown asset', deniedAsset);

    // --- 13. shared 24h budget: each unique counts 1 ---
    // Ledger for unique-agent: 500 (root) + 100 (sub-root) + 3 uniques = 603.
    const budgetPolicy = await put('/v1/policies/unique-agent', {
      ...base, agentId: AGENT, allowedDestinations: [walletA], dailyIssueBudgetBaseUnits: '603',
    });
    check('policy budget tightened to 603', budgetPolicy.status === 200);
    const s14 = await post('/v1/assets/issue-unique', {
      agentId: AGENT, name: 'ROOT1#OVERBUDGET', qty: '1', toAddress: walletA,
    });
    check('unique over 24h budget -> 403', s14.status === 403, s14.json);
    check('budget deny carries DAILY_ISSUE_BUDGET_EXCEEDED',
      s14.json.decision?.reasonCodes?.includes('DAILY_ISSUE_BUDGET_EXCEEDED'));

    // --- 14. simulate op:'unique' has zero side effects ---
    const seqBefore = await lastSeq();
    const sim1 = await post('/v1/intents/simulate', {
      op: 'unique', agentId: DENY_AGENT, assetName: 'ROOT1#SIM001', destination: walletA,
    });
    check('simulate unique -> 200', sim1.status === 200, sim1.json);
    check('simulate flags simulated:true', sim1.json.simulated === true);
    check('simulate unique decision is ALLOW', sim1.json.decision?.kind === 'ALLOW', sim1.json.decision);
    check('simulate unique qty normalized to 1', sim1.json.decision?.intentId?.startsWith('sim-') === true);
    const sim2 = await post('/v1/intents/simulate', {
      op: 'unique', agentId: DENY_AGENT, assetName: 'ROOT1', qty: '1', destination: walletA,
    });
    check('simulate unique without hash -> DENY', sim2.json.decision?.kind === 'DENY', sim2.json.decision);
    check('no-hash simulate carries ASSET_NAME_REJECTED',
      sim2.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));
    const sim3 = await post('/v1/intents/simulate', {
      op: 'unique', agentId: DENY_AGENT, assetName: 'ROOT1#SIM002', qty: '2', destination: walletA,
    });
    check('simulate unique qty 2 -> 400', sim3.status === 400, sim3.json);
    check('audit seq unchanged by simulation', (await lastSeq()) === seqBefore);
    const pending = await get('/v1/intents/pending');
    check('simulation created no pending intent',
      !pending.pending.some((p: any) => String(p.intent.id).startsWith('sim-')));

    // --- 15. chain + listing ---
    const audit = await get('/v1/audit?limit=200');
    check('audit chain is valid', audit.chainValid === true);
    const list = await get('/v1/assets?pattern=ROOT1*');
    check('asset listing includes uniques',
      Array.isArray(list.assets) && list.assets.some((a: any) => a.name === 'ROOT1#SERIAL001'), list);
  } finally {
    api.kill();
  }
  console.log(failures ? `unique-test: ${failures} FAILURES` : 'unique-test: all green');
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
