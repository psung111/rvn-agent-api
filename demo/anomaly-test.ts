/**
 * anomaly-test: checks for anomaly detection (v0.12.0, slice 1).
 *
 *  pnpm test:anomaly
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - qty outlier: an agent with 3+ same-kind priors at qty 100 sees a
 *     qty-2000 issue (below cap and threshold, so otherwise ALLOW) held
 *     as REQUIRE_APPROVAL with ANOMALY_SUSPECTED — and the hold still
 *     approves through the normal path
 *   - boundary: exactly 10x the median qty does NOT flag (strictly-greater)
 *   - insufficient history: a fresh agent's first large-ish issue ALLOWs
 *     (no baseline, no false positive)
 *   - first-seen destination burst: 3 recent intents then an issue to an
 *     allowlisted-but-never-used destination holds as ANOMALY_SUSPECTED;
 *     with only 2 recent intents the same issue ALLOWs
 *   - hard denies still win: an over-cap outlier DENYs with
 *     ISSUE_CAP_EXCEEDED and no ANOMALY_SUSPECTED
 *   - simulate runs the same anomaly gate with zero side effects (no
 *     audit entries, no pending intent, no baseline pollution)
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3128;
const API = `http://127.0.0.1:${API_PORT}`;

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
  const api = await bootApi();
  try {
    const health = await get('/v1/health');
    check('API booted in mock mode', health.json?.ok === true && health.json?.mock === true);

    const wallet = (await post('/v1/wallets', {})).json?.address as string;
    const wallet2 = (await post('/v1/wallets', {})).json?.address as string;
    check('two wallets provisioned', typeof wallet === 'string' && typeof wallet2 === 'string' && wallet !== wallet2);

    const setPolicy = async (agent: string, allowed: string[]) => {
      const base = await get(`/v1/policies/${agent}`);
      return put(`/v1/policies/${agent}`, { ...base.json, agentId: agent, allowedDestinations: allowed });
    };
    const issue = (agent: string, name: string, qty: string, to: string) =>
      post('/v1/assets/issue', { agentId: agent, name, qty, toAddress: to });

    // ---- A. qty outlier holds, then approves normally ----
    check('policy set for anom-qty', (await setPolicy('anom-qty', [wallet])).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-qty', `ANOMQ${i}`, '100', wallet);
      check(`anom-qty baseline issue ${i} ALLOWs`, r.status === 200 && r.json?.decision?.kind === 'ALLOW', r);
    }
    const outlier = await issue('anom-qty', 'ANOMQ4', '2000', wallet);
    check('qty 2000 (>10x median 100, below threshold) holds (202)',
      outlier.status === 202 && outlier.json?.decision?.kind === 'REQUIRE_APPROVAL', outlier);
    check('outlier reason is ANOMALY_SUSPECTED',
      outlier.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), outlier.json?.decision);
    const approved = await post(`/v1/intents/${outlier.json.intent.id}/approve`, { approver: 'paul' });
    check('anomaly hold approves through the normal path (200 + txid)',
      approved.status === 200 && typeof approved.json?.txid === 'string', approved);

    // ---- Boundary: exactly 10x the median does not flag ----
    check('policy set for anom-boundary', (await setPolicy('anom-boundary', [wallet])).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-boundary', `ANOMB${i}`, '100', wallet);
      check(`anom-boundary baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const boundary = await issue('anom-boundary', 'ANOMB4', '1000', wallet);
    check('qty exactly 10x median ALLOWs (strictly-greater rule)',
      boundary.status === 200 && boundary.json?.decision?.kind === 'ALLOW', boundary);

    // ---- Insufficient history: fresh agent, no false positive ----
    check('policy set for anom-fresh', (await setPolicy('anom-fresh', [wallet])).status === 200);
    const fresh = await issue('anom-fresh', 'ANOMF1', '2000', wallet);
    check('fresh agent first issue ALLOWs (no baseline, no anomaly)',
      fresh.status === 200 && fresh.json?.decision?.kind === 'ALLOW', fresh);

    // ---- B. first-seen destination burst ----
    check('policy set for anom-burst', (await setPolicy('anom-burst', [wallet, wallet2])).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-burst', `ANOMR${i}`, '100', wallet);
      check(`anom-burst baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const burst = await issue('anom-burst', 'ANOMR4', '100', wallet2);
    check('first-seen destination inside a burst holds (202)',
      burst.status === 202 && burst.json?.decision?.kind === 'REQUIRE_APPROVAL', burst);
    check('burst reason is ANOMALY_SUSPECTED',
      burst.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), burst.json?.decision);
    const burstApproved = await post(`/v1/intents/${burst.json.intent.id}/approve`, { approver: 'paul' });
    check('burst hold approves normally', burstApproved.status === 200 && !!burstApproved.json?.txid, burstApproved);

    // ---- Burst negative: only 2 recent intents, new destination ALLOWs ----
    check('policy set for anom-burst-neg', (await setPolicy('anom-burst-neg', [wallet, wallet2])).status === 200);
    for (let i = 1; i <= 2; i++) {
      const r = await issue('anom-burst-neg', `ANOMN${i}`, '100', wallet);
      check(`anom-burst-neg baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const noBurst = await issue('anom-burst-neg', 'ANOMN3', '100', wallet2);
    check('new destination with only 2 recent intents ALLOWs',
      noBurst.status === 200 && noBurst.json?.decision?.kind === 'ALLOW', noBurst);

    // ---- C. hard denies still win over the anomaly gate ----
    check('policy set for anom-deny', (await setPolicy('anom-deny', [wallet])).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-deny', `ANOMD${i}`, '100', wallet);
      check(`anom-deny baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const denied = await issue('anom-deny', 'ANOMD4', '500000', wallet);
    check('over-cap outlier DENYs (403)',
      denied.status === 403 && denied.json?.decision?.kind === 'DENY', denied);
    check('deny reason is ISSUE_CAP_EXCEEDED',
      denied.json?.decision?.reasonCodes?.includes('ISSUE_CAP_EXCEEDED'), denied.json?.decision);
    check('deny reason is not ANOMALY_SUSPECTED',
      !denied.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), denied.json?.decision);

    // ---- D. simulate runs the anomaly gate with zero side effects ----
    check('policy set for anom-sim', (await setPolicy('anom-sim', [wallet])).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-sim', `ANOMS${i}`, '100', wallet);
      check(`anom-sim baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const lastSeq = async (): Promise<number> => {
      const tail = await get('/v1/audit?limit=1');
      return tail.json?.entries?.length ? tail.json.entries[0].seq : 0;
    };
    const seqBefore = await lastSeq();
    const sim = await post('/v1/intents/simulate', {
      op: 'issue', agentId: 'anom-sim', assetName: 'ANOMS4', qty: '2000', destination: wallet,
    });
    check('simulate qty outlier -> REQUIRE_APPROVAL ANOMALY_SUSPECTED',
      sim.status === 200 && sim.json?.simulated === true &&
      sim.json?.decision?.kind === 'REQUIRE_APPROVAL' &&
      sim.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), sim);
    check('simulation writes no audit entries', (await lastSeq()) === seqBefore);
    check('simulation leaves no pending intent', (await get('/v1/intents/pending')).json?.pending?.length === 0);
    const afterSim = await issue('anom-sim', 'ANOMS5', '500', wallet);
    check('real issue after simulation still ALLOWs (sim polluted nothing)',
      afterSim.status === 200 && afterSim.json?.decision?.kind === 'ALLOW', afterSim);

    // ---- Audit chain still valid ----
    const audit = await get('/v1/audit?limit=200');
    check('audit chain valid after anomaly operations', audit.json?.chainValid === true, audit.json?.chainValid);
  } finally {
    api.kill();
  }
  console.log(failures === 0 ? 'anomaly-test: all green' : `anomaly-test: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
