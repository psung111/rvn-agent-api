/**
 * simulate-test: checks for the POST /v1/intents/simulate dry-run endpoint.
 *
 *  pnpm test:simulate
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - simulate returns the policy decision for issue and transfer
 *   - the simulation has zero side effects: nothing persisted, no issue spend
 *     recorded, no audit entries, no approver notifications, nothing on node
 *   - a simulated decision id is not approvable (404)
 *   - invalid bodies return 400
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3123;
const API = `http://127.0.0.1:${API_PORT}`;
const AGENT = 'sim-agent';

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

    const { address } = (await post('/v1/wallets', {})).json;
    check('provisioned a wallet', typeof address === 'string' && address.length > 0);

    // Tighten the policy for sim-agent: allowlist the wallet, shrink the
    // 24h budget to 1000 so budget accounting is observable.
    const base = await get('/v1/policies/sim-agent');
    const putPolicy = await put('/v1/policies/sim-agent', {
      ...base, agentId: AGENT, allowedDestinations: [address], dailyIssueBudgetBaseUnits: '1000',
    });
    check('policy updated for sim-agent', putPolicy.status === 200);

    const lastSeq = async (): Promise<number> => {
      const tail = await get('/v1/audit?limit=1');
      return tail.entries.length ? tail.entries[0].seq : 0;
    };

    const seqBefore = await lastSeq();
    const pendingBefore = await get('/v1/intents/pending');

    // --- 1. simulate an issue within policy ---
    const s1 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'SIMCOIN1', qty: '500', destination: address,
    });
    check('simulate issue within policy -> 200', s1.status === 200, s1);
    check('simulate flags simulated:true', s1.json.simulated === true);
    check('simulate issue decision is ALLOW', s1.json.decision?.kind === 'ALLOW', s1.json.decision);
    check('simulate issue reason is WITHIN_POLICY', s1.json.decision?.reasonCodes?.includes('WITHIN_POLICY'));
    check('simulate carries a dry-run note', typeof s1.json.note === 'string' && /dry run/.test(s1.json.note));
    const d = s1.json.decision;
    check('decision TTL window is sane', d.expiresAtMs > d.decidedAtMs);
    check('simulated intent id is namespaced', typeof d.intentId === 'string' && d.intentId.startsWith('sim-'), d.intentId);
    const simId: string = d.intentId;

    // --- 2. zero side effects from the simulation ---
    check('audit chain untouched by simulation', (await lastSeq()) === seqBefore);
    const pendingAfterSim = await get('/v1/intents/pending');
    check('simulated intent not in pending list', pendingAfterSim.pending.length === pendingBefore.pending.length);
    const approveSim = await post(`/v1/intents/${simId}/approve`, {});
    check('simulated decision id is not approvable (404)', approveSim.status === 404);
    const denySim = await post(`/v1/intents/${simId}/deny`, {});
    check('simulated decision id is not deniable (404)', denySim.status === 404);

    // --- 3. simulate an over-cap issue ---
    const s2 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'SIMCOIN2', qty: '500000', destination: address,
    });
    check('over-cap simulate -> DENY', s2.status === 200 && s2.json.decision?.kind === 'DENY');
    check('over-cap reason is ISSUE_CAP_EXCEEDED', s2.json.decision?.reasonCodes?.includes('ISSUE_CAP_EXCEEDED'));

    // --- 4. budget accounting: sim reads the ledger but never writes ---
    const real1 = await post('/v1/assets/issue', {
      agentId: AGENT, name: 'REALCOIN1', qty: '600', toAddress: address,
    });
    check('real issue of 600 records spend', real1.status === 200 && real1.json.decision?.kind === 'ALLOW');
    const s3 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'REALCOIN2', qty: '600', destination: address,
    });
    check('simulate of 600 now exceeds budget (600+600>1000)',
      s3.status === 200 && s3.json.decision?.kind === 'DENY' &&
      s3.json.decision?.reasonCodes?.includes('DAILY_ISSUE_BUDGET_EXCEEDED'), s3.json.decision);
    const real2 = await post('/v1/assets/issue', {
      agentId: AGENT, name: 'REALCOIN3', qty: '400', toAddress: address,
    });
    check('real issue of 400 still ALLOWs — the sim consumed no budget',
      real2.status === 200 && real2.json.decision?.kind === 'ALLOW', real2.json.decision);

    // --- 5. REQUIRE_APPROVAL path stays purely hypothetical ---
    const seqBeforeHold = await lastSeq();
    const s4 = await post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'SIMCOIN1', qty: '100',
      destination: 'mtest1stranger000001xxxxxxxxxxxx',
    });
    check('simulate transfer to unknown dest -> REQUIRE_APPROVAL',
      s4.status === 200 && s4.json.decision?.kind === 'REQUIRE_APPROVAL');
    check('reason is DESTINATION_NOT_ALLOWLISTED',
      s4.json.decision?.reasonCodes?.includes('DESTINATION_NOT_ALLOWLISTED'));
    check('simulated hold is not in pending list', (await get('/v1/intents/pending')).pending.length === 0);
    check('simulated hold writes no audit entries (no notification attempted)',
      (await lastSeq()) === seqBeforeHold);

    // --- 6. transfer op within policy ---
    const s5 = await post('/v1/intents/simulate', {
      op: 'transfer', agentId: AGENT, assetName: 'SIMCOIN1', qty: '100', destination: address,
    });
    check('simulate transfer within policy -> ALLOW', s5.status === 200 && s5.json.decision?.kind === 'ALLOW');

    // --- 7. field aliases and bad asset name ---
    // Fresh agent so the earlier budget spend above doesn't interfere.
    const base2 = await get('/v1/policies/sim-agent-alias');
    const put2 = await put('/v1/policies/sim-agent-alias', {
      ...base2, agentId: 'sim-agent-alias', allowedDestinations: [address],
    });
    check('policy updated for sim-agent-alias', put2.status === 200);
    const s6 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: 'sim-agent-alias', name: 'SIMCOIN4', qty: '100', toAddress: address,
    });
    check('name/toAddress aliases work', s6.status === 200 && s6.json.decision?.kind === 'ALLOW');
    const s7 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: AGENT, assetName: 'bad name!!', qty: '100', destination: address,
    });
    check('bad asset name simulate -> DENY ASSET_NAME_REJECTED',
      s7.status === 200 && s7.json.decision?.kind === 'DENY' &&
      s7.json.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'));

    // --- 8. invalid bodies -> 400 ---
    for (const [label, body] of [
      ['unknown op', { op: 'burn', assetName: 'X', qty: '1', destination: address }],
      ['missing op', { assetName: 'X', qty: '1', destination: address }],
      ['missing qty', { op: 'issue', assetName: 'X', destination: address }],
      ['non-numeric qty', { op: 'issue', assetName: 'X', qty: 'abc', destination: address }],
      ['fractional qty', { op: 'issue', assetName: 'X', qty: '1.5', destination: address }],
      ['missing destination', { op: 'issue', assetName: 'X', qty: '1' }],
    ] as Array<[string, unknown]>) {
      const r = await post('/v1/intents/simulate', body);
      check(`400 on ${label}`, r.status === 400 && typeof r.json?.error === 'string', r);
    }
  } finally {
    api.kill();
  }
  console.log(failures ? `simulate-test: FAILED (${failures})` : 'simulate-test: all green');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
