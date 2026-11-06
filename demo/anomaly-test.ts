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
 *   - v0.22.0: anomaly thresholds as policy fields — a tighter
 *     anomalyQtyMultiple holds earlier (exactly the multiple ALLOWs),
 *     a higher anomalyMinHistory delays flagging until enough samples
 *     exist, a higher anomalyBurstMinCount / shorter
 *     anomalyBurstWindowSeconds defuse the burst signal; malformed
 *     fields 400 on PUT and preset-override and store nothing; the
 *     lenient parse / strict validation split is unit-checked
 *   - v0.22.0: GET /v1/anomaly/:agentId stats — holds raised over the
 *     window, split by signal, pending count, thresholds in force;
 *     approved holds still count as raised, reads are pure, unknown
 *     agents report zeros with the defaults
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  anomalyConfigFromPolicy,
  DEFAULT_ANOMALY_CONFIG,
  validateAnomalyFields,
} from '../src/policy/anomaly.js';

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
  // ---- 0. config parse/validate unit checks (no API needed) ----
  const defaults = anomalyConfigFromPolicy({});
  check('empty policy resolves to v0.12.0 defaults',
    defaults.qtyMultiple === 10n && defaults.minHistory === 3 &&
    defaults.burstWindowMs === 3600_000 && defaults.burstMinCount === 3,
    defaults);
  check('DEFAULT_ANOMALY_CONFIG matches the v0.12.0 constants',
    DEFAULT_ANOMALY_CONFIG.qtyMultiple === 10n && DEFAULT_ANOMALY_CONFIG.minHistory === 3);
  const tuned = anomalyConfigFromPolicy({
    anomalyQtyMultiple: 2, anomalyMinHistory: 5,
    anomalyBurstWindowSeconds: 60, anomalyBurstMinCount: 2,
  });
  check('valid fields resolve (multiple 2, history 5, window 60s, burst 2)',
    tuned.qtyMultiple === 2n && tuned.minHistory === 5 &&
    tuned.burstWindowMs === 60_000 && tuned.burstMinCount === 2, tuned);
  const malformed = anomalyConfigFromPolicy({
    anomalyQtyMultiple: 0, anomalyMinHistory: 1.5,
    anomalyBurstWindowSeconds: 'x' as unknown as number, anomalyBurstMinCount: -1,
  });
  check('malformed fields fall back to defaults per field, never crash',
    malformed.qtyMultiple === 10n && malformed.minHistory === 3 &&
    malformed.burstWindowMs === 3600_000 && malformed.burstMinCount === 3, malformed);
  check('strict validation accepts a full valid set',
    validateAnomalyFields({
      anomalyQtyMultiple: 2, anomalyMinHistory: 5,
      anomalyBurstWindowSeconds: 60, anomalyBurstMinCount: 2,
    }) === undefined);
  check('strict validation accepts an empty set',
    validateAnomalyFields({}) === undefined);
  for (const bad of [
    { anomalyQtyMultiple: 0 }, { anomalyQtyMultiple: 1.5 }, { anomalyQtyMultiple: 'x' as unknown as number },
    { anomalyMinHistory: 0 }, { anomalyBurstWindowSeconds: -1 }, { anomalyBurstMinCount: 0 },
  ]) {
    check(`strict validation rejects ${JSON.stringify(bad)}`,
      typeof validateAnomalyFields(bad) === 'string', validateAnomalyFields(bad));
  }

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

    // ---- E. policy fields tune the gate ----
    const setAnomalyPolicy = async (agent: string, fields: Record<string, unknown>) => {
      const base = await get(`/v1/policies/${agent}`);
      return put(`/v1/policies/${agent}`, { ...base.json, agentId: agent, allowedDestinations: [wallet, wallet2], ...fields });
    };
    // E1. tighter multiple: qty 250 (>2x median 100) holds; exactly 2x ALLOWs.
    check('policy set for anom-mult', (await setAnomalyPolicy('anom-mult', { anomalyQtyMultiple: 2 })).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-mult', `ANOMM${i}`, '100', wallet);
      check(`anom-mult baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const multHold = await issue('anom-mult', 'ANOMM4', '250', wallet);
    check('qty 250 (>2x median 100) holds under anomalyQtyMultiple 2',
      multHold.status === 202 && multHold.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), multHold);
    const multEdge = await issue('anom-mult', 'ANOMM5', '200', wallet);
    check('qty exactly 2x median ALLOWs under anomalyQtyMultiple 2 (strictly-greater)',
      multEdge.status === 200 && multEdge.json?.decision?.kind === 'ALLOW', multEdge);
    // E2. higher min history: 3 samples not enough when minHistory is 5.
    check('policy set for anom-minhist', (await setAnomalyPolicy('anom-minhist', { anomalyMinHistory: 5 })).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-minhist', `ANOMH${i}`, '100', wallet);
      check(`anom-minhist baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const earlyOutlier = await issue('anom-minhist', 'ANOMH4', '2000', wallet);
    check('qty 2000 ALLOWs with only 3 samples under anomalyMinHistory 5',
      earlyOutlier.status === 200 && earlyOutlier.json?.decision?.kind === 'ALLOW', earlyOutlier);
    for (let i = 5; i <= 6; i++) {
      const r = await issue('anom-minhist', `ANOMH${i}`, '100', wallet);
      check(`anom-minhist baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const lateOutlier = await issue('anom-minhist', 'ANOMH7', '2000', wallet);
    check('qty 2000 holds once 5 samples exist under anomalyMinHistory 5',
      lateOutlier.status === 202 && lateOutlier.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), lateOutlier);
    // E3. higher burst count: 3 recent intents not enough when burstMinCount is 5.
    check('policy set for anom-burstcount', (await setAnomalyPolicy('anom-burstcount', { anomalyBurstMinCount: 5 })).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-burstcount', `ANOMC${i}`, '100', wallet);
      check(`anom-burstcount baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const noBurstHigh = await issue('anom-burstcount', 'ANOMC4', '100', wallet2);
    check('new destination ALLOWs with 3 recent intents under anomalyBurstMinCount 5',
      noBurstHigh.status === 200 && noBurstHigh.json?.decision?.kind === 'ALLOW', noBurstHigh);
    // E4. short burst window: the burst ages out after 1s.
    check('policy set for anom-burstwin', (await setAnomalyPolicy('anom-burstwin', { anomalyBurstWindowSeconds: 1 })).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-burstwin', `ANOMW${i}`, '100', wallet);
      check(`anom-burstwin baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    await new Promise((r) => setTimeout(r, 1200));
    const agedBurst = await issue('anom-burstwin', 'ANOMW4', '100', wallet2);
    check('new destination ALLOWs once the 1s burst window has aged out',
      agedBurst.status === 200 && agedBurst.json?.decision?.kind === 'ALLOW', agedBurst);
    // E5. PUT validation: malformed anomaly fields 400 and store nothing.
    const badPuts: Array<Record<string, unknown>> = [
      { anomalyQtyMultiple: 0 }, { anomalyQtyMultiple: 1.5 }, { anomalyQtyMultiple: 'x' },
      { anomalyMinHistory: 0 }, { anomalyBurstWindowSeconds: -1 }, { anomalyBurstMinCount: 0 },
    ];
    for (const bad of badPuts) {
      const r = await setAnomalyPolicy('anom-badput', bad);
      check(`PUT with ${JSON.stringify(bad)} 400s`, r.status === 400, r);
    }
    const badPutPolicy = await get('/v1/policies/anom-badput');
    check('failed PUTs left the agent on the default policy (no anomaly fields)',
      badPutPolicy.json?.anomalyQtyMultiple === undefined &&
      badPutPolicy.json?.anomalyMinHistory === undefined, badPutPolicy.json);
    // E6. preset override: balanced + anomalyQtyMultiple 2 tunes the gate.
    const preset = await post('/v1/policies/anom-preset/preset', {
      preset: 'balanced', overrides: { allowedDestinations: [wallet, wallet2], anomalyQtyMultiple: 2 },
    });
    check('apply_preset balanced with anomalyQtyMultiple 2 200s',
      preset.status === 200 && preset.json?.policy?.anomalyQtyMultiple === 2, preset);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-preset', `ANOMP${i}`, '100', wallet);
      check(`anom-preset baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const presetHold = await issue('anom-preset', 'ANOMP4', '250', wallet);
    check('preset override multiple 2 holds qty 250',
      presetHold.status === 202 && presetHold.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), presetHold);
    const badPreset = await post('/v1/policies/anom-preset-bad/preset', {
      preset: 'balanced', overrides: { anomalyQtyMultiple: 0 },
    });
    check('apply_preset with anomalyQtyMultiple 0 400s', badPreset.status === 400, badPreset);

    // ---- F. anomaly stats endpoint ----
    check('policy set for anom-stats', (await setAnomalyPolicy('anom-stats', {})).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('anom-stats', `ANOMT${i}`, '100', wallet);
      check(`anom-stats baseline issue ${i} ALLOWs`, r.status === 200, r);
    }
    const statsOutlier = await issue('anom-stats', 'ANOMT4', '2000', wallet);
    check('anom-stats outlier holds', statsOutlier.status === 202 &&
      statsOutlier.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), statsOutlier);
    const statsBurst = await issue('anom-stats', 'ANOMT5', '100', wallet2);
    check('anom-stats burst holds', statsBurst.status === 202 &&
      statsBurst.json?.decision?.reasonCodes?.includes('ANOMALY_SUSPECTED'), statsBurst);
    const stats = await get('/v1/anomaly/anom-stats');
    check('stats reports 2 anomaly holds over 5 intents in window',
      stats.status === 200 && stats.json?.anomalyHolds === 2 && stats.json?.intentsInWindow === 5, stats.json);
    check('stats splits holds by signal (1 qty outlier, 1 burst)',
      stats.json?.bySignal?.QTY_OUTLIER === 1 &&
      stats.json?.bySignal?.FIRST_SEEN_DESTINATION_BURST === 1, stats.json?.bySignal);
    check('stats reports 2 pending anomaly holds',
      stats.json?.anomalyHoldsPending === 2, stats.json);
    check('stats echoes the default thresholds',
      stats.json?.thresholds?.qtyMultiple === 10 && stats.json?.thresholds?.minHistory === 3 &&
      stats.json?.thresholds?.burstWindowSeconds === 3600 &&
      stats.json?.thresholds?.burstMinCount === 3, stats.json?.thresholds);
    check('stats window defaults to 24h', stats.json?.windowHours === 24, stats.json);
    const seqBeforeStats = await lastSeq();
    const statsAgain = await get('/v1/anomaly/anom-stats?windowHours=bogus');
    check('stats read is pure (no audit entries, window falls back to 24)',
      (await lastSeq()) === seqBeforeStats && statsAgain.json?.windowHours === 24, statsAgain.json);
    const statsApproved = await post(`/v1/intents/${statsOutlier.json.intent.id}/approve`, { approver: 'paul' });
    check('stats outlier hold approves normally', statsApproved.status === 200 && !!statsApproved.json?.txid, statsApproved);
    const statsAfter = await get('/v1/anomaly/anom-stats');
    check('approved hold still counts as raised, pending drops to 1',
      statsAfter.json?.anomalyHolds === 2 && statsAfter.json?.anomalyHoldsPending === 1, statsAfter.json);
    const unknownStats = await get('/v1/anomaly/anom-never-seen');
    check('unknown agent stats: zero holds, default thresholds',
      unknownStats.status === 200 && unknownStats.json?.anomalyHolds === 0 &&
      unknownStats.json?.intentsInWindow === 0 &&
      unknownStats.json?.thresholds?.qtyMultiple === 10, unknownStats.json);

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
