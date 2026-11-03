/**
 * ratelimit-test: checks for rate limiting (v0.18.0, slice 1).
 *
 *  pnpm test:ratelimit
 *
 * Unit: TokenBucket burst / refill / peek-without-consuming behavior with
 * fake timestamps, plus rateLimitFromPolicy and validateRateLimitFields
 * parsing (pair-or-neither, positive integers, malformed -> unlimited).
 * Integration: boots the real API as a child process (MOCK_RVN=true) and
 * asserts:
 *   - a 3-op / 3600s agent ALLOWs 3 issues, then the 4th answers 429 with
 *     decision DENY / RATE_LIMIT_EXCEEDED and creates no asset
 *   - buckets are per-agent: an unlimited agent issues freely while the
 *     limited agent is exhausted
 *   - simulate peeks: it reports ALLOW while a token remains (twice in a
 *     row, proving the peek spent nothing), then DENY
 *     RATE_LIMIT_EXCEEDED once the bucket is spent — with zero audit
 *     entries and no pending intent — and a real submit after that still
 *     answers 429
 *   - refill: a 2-op / 2s bucket ALLOWs 2, answers 429, then ALLOWs again
 *     after ~1.2s of refill
 *   - transfers share the agent's bucket: 1-op agent transfers once, then
 *     429s on the second transfer
 *   - PUT validation: half a pair, zero, and fractional values all 400;
 *     a full valid pair 200s and reads back
 *   - preset overrides: a full rate-limit override applies, a half
 *     override 400s
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  rateLimitFromPolicy,
  TokenBucket,
  validateRateLimitFields,
} from '../src/policy/ratelimit.js';
import { defaultPolicy } from '../src/policy/index.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3129;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ---- Unit: token bucket ----
  const bucket = new TokenBucket();
  const cfg = { maxOps: 3, windowSeconds: 60 };
  check('bucket starts full: 3 consumes succeed',
    bucket.tryConsume('a', cfg, 1000) && bucket.tryConsume('a', cfg, 1000) && bucket.tryConsume('a', cfg, 1000));
  check('4th consume at same instant fails', bucket.tryConsume('a', cfg, 1000) === false);
  check('failed consume spends nothing: still fails 1ms later (no refill yet)',
    bucket.tryConsume('a', cfg, 1001) === false);
  check('refill: 20s of a 60s window restores 1 token (3/60 per s)',
    bucket.tryConsume('a', cfg, 21000) === true);
  check('wouldAllow peeks without spending: fresh bucket allows twice in a row',
    bucket.wouldAllow('b', cfg, 1000) === true && bucket.wouldAllow('b', cfg, 1000) === true);
  check('peek does not consume: the peeked bucket still has all 3 tokens',
    bucket.tryConsume('b', cfg, 1000) && bucket.tryConsume('b', cfg, 1000) && bucket.tryConsume('b', cfg, 1000));
  check('wouldAllow false on an empty bucket',
    bucket.wouldAllow('a', cfg, 21000) === false);
  check('backwards clock never drains: wouldAllow at an earlier time still false, not negative',
    bucket.wouldAllow('a', cfg, 1000) === false);
  check('buckets are per-key: another key is unaffected',
    bucket.tryConsume('c', cfg, 21000) === true);

  // ---- Unit: snapshot (v0.19.0 stats) ----
  const snapFresh = bucket.snapshot('snap-fresh', cfg, 1000);
  check('snapshot of a fresh bucket reports full',
    snapFresh.tokensAvailable === 3 && snapFresh.wouldAllow === true &&
    snapFresh.secondsUntilNextToken === 0 && snapFresh.secondsUntilFull === 0 &&
    snapFresh.refillRatePerSecond === 0.05, snapFresh);
  const snapEmpty = bucket.snapshot('a', cfg, 21000);
  check('snapshot of an exhausted bucket reports 0 tokens and refill times',
    snapEmpty.tokensAvailable === 0 && snapEmpty.wouldAllow === false &&
    snapEmpty.secondsUntilNextToken === 20 && snapEmpty.secondsUntilFull === 60, snapEmpty);
  const snapPure1 = bucket.snapshot('snap-pure', cfg, 1000);
  const snapPure2 = bucket.snapshot('snap-pure', cfg, 1000);
  check('snapshot is pure: two snapshots agree and spend nothing',
    JSON.stringify(snapPure1) === JSON.stringify(snapPure2) &&
    bucket.tryConsume('snap-pure', cfg, 1000) && bucket.tryConsume('snap-pure', cfg, 1000) &&
    bucket.tryConsume('snap-pure', cfg, 1000));
  const partial = new TokenBucket();
  partial.tryConsume('p', cfg, 1000);
  partial.tryConsume('p', cfg, 1000);
  const snapPartial = partial.snapshot('p', cfg, 11000);
  check('snapshot partial refill: 1.5 tokens -> 1 whole, 10s to next, 30s to full',
    snapPartial.tokensAvailable === 1 && snapPartial.wouldAllow === true &&
    snapPartial.secondsUntilNextToken === 10 && snapPartial.secondsUntilFull === 30, snapPartial);

  // ---- Unit: policy parsing / validation ----
  check('rateLimitFromPolicy: full pair parses',
    JSON.stringify(rateLimitFromPolicy({ ...defaultPolicy(), rateLimitMaxOps: 5, rateLimitWindowSeconds: 60 }))
      === JSON.stringify({ maxOps: 5, windowSeconds: 60 }));
  check('rateLimitFromPolicy: missing pair means unlimited',
    rateLimitFromPolicy(defaultPolicy()) === undefined);
  check('rateLimitFromPolicy: half pair means unlimited',
    rateLimitFromPolicy({ ...defaultPolicy(), rateLimitMaxOps: 5 }) === undefined);
  check('rateLimitFromPolicy: zero / fractional values mean unlimited',
    rateLimitFromPolicy({ ...defaultPolicy(), rateLimitMaxOps: 0, rateLimitWindowSeconds: 60 }) === undefined &&
    rateLimitFromPolicy({ ...defaultPolicy(), rateLimitMaxOps: 5.5, rateLimitWindowSeconds: 60 }) === undefined);
  check('validateRateLimitFields: neither set is valid',
    validateRateLimitFields({}) === undefined);
  check('validateRateLimitFields: half pair is invalid',
    typeof validateRateLimitFields({ rateLimitMaxOps: 5 }) === 'string');
  check('validateRateLimitFields: zero / fractional values are invalid',
    typeof validateRateLimitFields({ rateLimitMaxOps: 0, rateLimitWindowSeconds: 60 }) === 'string' &&
    typeof validateRateLimitFields({ rateLimitMaxOps: 5, rateLimitWindowSeconds: 1.5 }) === 'string');
  check('validateRateLimitFields: full valid pair passes',
    validateRateLimitFields({ rateLimitMaxOps: 5, rateLimitWindowSeconds: 60 }) === undefined);

  // ---- Integration ----
  const api = await bootApi();
  try {
    const health = await get('/v1/health');
    check('API booted in mock mode', health.json?.ok === true && health.json?.mock === true);

    const wallet = (await post('/v1/wallets', {})).json?.address as string;
    check('wallet provisioned', typeof wallet === 'string' && wallet.length > 0);

    const setPolicy = async (agent: string, extra: Record<string, unknown>) => {
      const base = await get(`/v1/policies/${agent}`);
      return put(`/v1/policies/${agent}`, { ...base.json, agentId: agent, allowedDestinations: [wallet], ...extra });
    };
    const issue = (agent: string, name: string, qty = '100') =>
      post('/v1/assets/issue', { agentId: agent, name, qty, toAddress: wallet });

    // ---- A. burst then 429, nothing executed ----
    check('policy set for rl-burst (3 ops / 3600s)',
      (await setPolicy('rl-burst', { rateLimitMaxOps: 3, rateLimitWindowSeconds: 3600 })).status === 200);
    for (let i = 1; i <= 3; i++) {
      const r = await issue('rl-burst', `RLB${i}`);
      check(`rl-burst issue ${i} ALLOWs`, r.status === 200 && r.json?.decision?.kind === 'ALLOW', r);
    }
    const limited = await issue('rl-burst', 'RLB4');
    check('4th issue answers 429', limited.status === 429, limited);
    check('429 decision is DENY / RATE_LIMIT_EXCEEDED',
      limited.json?.decision?.kind === 'DENY' &&
      limited.json?.decision?.reasonCodes?.includes('RATE_LIMIT_EXCEEDED'), limited.json?.decision);
    const assets = await get('/v1/assets?pattern=RLB*');
    check('rate-limited issue created no asset',
      !assets.json?.assets?.some((a: any) => a.name === 'RLB4'), assets.json);
    check('rate-limited intent is not pending (it is denied, not held)',
      (await get('/v1/intents/pending')).json?.pending?.length === 0);

    // ---- B. per-agent isolation ----
    check('policy set for rl-free (allowlisted, no rate limit)',
      (await setPolicy('rl-free', {})).status === 200);
    const free = await issue('rl-free', 'RLFREE1');
    check('unlimited agent issues freely while rl-burst is exhausted',
      free.status === 200 && free.json?.decision?.kind === 'ALLOW', free);

    // ---- C. simulate peeks without spending ----
    check('policy set for rl-sim (1 op / 3600s)',
      (await setPolicy('rl-sim', { rateLimitMaxOps: 1, rateLimitWindowSeconds: 3600 })).status === 200);
    const lastSeq = async (): Promise<number> => {
      const tail = await get('/v1/audit?limit=1');
      return tail.json?.entries?.length ? tail.json.entries[0].seq : 0;
    };
    const sim1 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: 'rl-sim', assetName: 'RLS1', qty: '100', destination: wallet,
    });
    check('simulate with a token left reports ALLOW',
      sim1.status === 200 && sim1.json?.simulated === true && sim1.json?.decision?.kind === 'ALLOW', sim1);
    const sim2 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: 'rl-sim', assetName: 'RLS1', qty: '100', destination: wallet,
    });
    check('second simulate still ALLOWs (the peek spent nothing)',
      sim2.status === 200 && sim2.json?.decision?.kind === 'ALLOW', sim2);
    const seqBefore = await lastSeq();
    const real1 = await issue('rl-sim', 'RLS1');
    check('real issue then ALLOWs (spends the one token)',
      real1.status === 200 && real1.json?.decision?.kind === 'ALLOW', real1);
    const sim3 = await post('/v1/intents/simulate', {
      op: 'issue', agentId: 'rl-sim', assetName: 'RLS2', qty: '100', destination: wallet,
    });
    check('simulate on an exhausted bucket reports DENY / RATE_LIMIT_EXCEEDED',
      sim3.status === 200 && sim3.json?.simulated === true &&
      sim3.json?.decision?.kind === 'DENY' &&
      sim3.json?.decision?.reasonCodes?.includes('RATE_LIMIT_EXCEEDED'), sim3);
    // seqBefore was taken before the real issue, which appends exactly
    // two entries (DECISION + EXECUTION_SKIPPED); the exhausted simulate
    // after it must append none.
    const seqAfterSim = await lastSeq();
    check('exhausted simulate writes no audit entries', seqAfterSim === seqBefore + 2,
      { seqBefore, seqAfterSim });
    const real2 = await issue('rl-sim', 'RLS2');
    check('real issue after exhausted simulate still 429s',
      real2.status === 429 && real2.json?.decision?.reasonCodes?.includes('RATE_LIMIT_EXCEEDED'), real2);

    // ---- D. refill over a short window ----
    check('policy set for rl-refill (2 ops / 2s)',
      (await setPolicy('rl-refill', { rateLimitMaxOps: 2, rateLimitWindowSeconds: 2 })).status === 200);
    check('rl-refill issue 1 ALLOWs', (await issue('rl-refill', 'RLR1')).status === 200);
    check('rl-refill issue 2 ALLOWs', (await issue('rl-refill', 'RLR2')).status === 200);
    check('rl-refill issue 3 429s', (await issue('rl-refill', 'RLR3')).status === 429);
    await sleep(1250);
    const refilled = await issue('rl-refill', 'RLR3');
    check('after ~1.2s of a 2s window, an issue ALLOWs again (refill)',
      refilled.status === 200 && refilled.json?.decision?.kind === 'ALLOW', refilled);

    // ---- E. transfers share the agent bucket ----
    check('policy set for agent-1 (allowlisted, no rate limit)',
      (await setPolicy('agent-1', {})).status === 200);
    const seed = await issue('agent-1', 'RLTRANSFER');
    check('seed asset for transfer test issued', seed.status === 200, seed);
    check('policy set for rl-transfer (1 op / 3600s)',
      (await setPolicy('rl-transfer', { rateLimitMaxOps: 1, rateLimitWindowSeconds: 3600 })).status === 200);
    const t1 = await post('/v1/assets/transfer', {
      agentId: 'rl-transfer', assetName: 'RLTRANSFER', qty: '10', destination: wallet,
    });
    check('first transfer ALLOWs', t1.status === 200 && t1.json?.decision?.kind === 'ALLOW', t1);
    const t2 = await post('/v1/assets/transfer', {
      agentId: 'rl-transfer', assetName: 'RLTRANSFER', qty: '10', destination: wallet,
    });
    check('second transfer 429s (same agent bucket)',
      t2.status === 429 && t2.json?.decision?.reasonCodes?.includes('RATE_LIMIT_EXCEEDED'), t2);

    // ---- F. PUT validation ----
    const base = await get('/v1/policies/rl-put');
    check('PUT with only rateLimitMaxOps 400s',
      (await put('/v1/policies/rl-put', { ...base.json, agentId: 'rl-put', rateLimitMaxOps: 5 })).status === 400);
    check('PUT with zero window 400s',
      (await put('/v1/policies/rl-put', { ...base.json, agentId: 'rl-put', rateLimitMaxOps: 5, rateLimitWindowSeconds: 0 })).status === 400);
    check('PUT with fractional maxOps 400s',
      (await put('/v1/policies/rl-put', { ...base.json, agentId: 'rl-put', rateLimitMaxOps: 2.5, rateLimitWindowSeconds: 60 })).status === 400);
    check('PUT with a full valid pair 200s and reads back',
      (await put('/v1/policies/rl-put', { ...base.json, agentId: 'rl-put', rateLimitMaxOps: 5, rateLimitWindowSeconds: 60 })).status === 200 &&
      (await get('/v1/policies/rl-put')).json?.rateLimitMaxOps === 5 &&
      (await get('/v1/policies/rl-put')).json?.rateLimitWindowSeconds === 60);

    // ---- G. preset overrides ----
    const presetOk = await post('/v1/policies/rl-preset/preset', {
      preset: 'balanced', overrides: { allowedDestinations: [wallet], rateLimitMaxOps: 2, rateLimitWindowSeconds: 3600 },
    });
    check('preset apply with a full rate-limit override 200s',
      presetOk.status === 200 && presetOk.json?.policy?.rateLimitMaxOps === 2, presetOk);
    const presetHalf = await post('/v1/policies/rl-preset/preset', {
      preset: 'balanced', overrides: { rateLimitMaxOps: 2 },
    });
    check('preset apply with a half rate-limit override 400s', presetHalf.status === 400, presetHalf);

    // ---- H. rate-limit stats endpoint (v0.19.0) ----
    const burstStats = await get('/v1/ratelimit/rl-burst');
    check('stats for an exhausted agent: limited, 0 tokens, no allow, ~1200s to next token',
      burstStats.json?.limited === true && burstStats.json?.maxOps === 3 &&
      burstStats.json?.windowSeconds === 3600 && burstStats.json?.tokensAvailable === 0 &&
      burstStats.json?.wouldAllow === false &&
      burstStats.json?.secondsUntilNextToken > 1000 && burstStats.json?.secondsUntilNextToken <= 1200, burstStats.json);
    check('reading stats spends nothing: rl-burst still 429s afterwards',
      (await issue('rl-burst', 'RLB5')).status === 429 &&
      (await get('/v1/ratelimit/rl-burst')).json?.tokensAvailable === 0);
    const freeStats = await get('/v1/ratelimit/rl-free');
    check('stats for an unlimited agent report limited: false',
      freeStats.json?.limited === false && freeStats.json?.agentId === 'rl-free', freeStats.json);
    check('policy set for rl-stats (2 ops / 3600s)',
      (await setPolicy('rl-stats', { rateLimitMaxOps: 2, rateLimitWindowSeconds: 3600 })).status === 200);
    const freshStats = await get('/v1/ratelimit/rl-stats');
    check('stats for a fresh limited agent report a full bucket',
      freshStats.json?.limited === true && freshStats.json?.tokensAvailable === 2 &&
      freshStats.json?.wouldAllow === true && freshStats.json?.secondsUntilNextToken === 0 &&
      freshStats.json?.secondsUntilFull === 0, freshStats.json);
    check('rl-stats issue 1 ALLOWs', (await issue('rl-stats', 'RLSSTAT1')).status === 200);
    const afterOne = await get('/v1/ratelimit/rl-stats');
    check('stats after one spend report 1 token left and still allow',
      afterOne.json?.tokensAvailable === 1 && afterOne.json?.wouldAllow === true, afterOne.json);
    check('stats for an unknown agent (default policy, unlimited) report limited: false',
      (await get('/v1/ratelimit/rl-never-seen')).json?.limited === false);

    // ---- Audit chain still valid ----
    const audit = await get('/v1/audit?limit=200');
    check('audit chain valid after rate-limit operations', audit.json?.chainValid === true, audit.json?.chainValid);
  } finally {
    api.kill();
  }
  console.log(failures === 0 ? 'ratelimit-test: all green' : `ratelimit-test: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
