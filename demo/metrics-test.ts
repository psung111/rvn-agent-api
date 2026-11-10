/**
 * metrics-test: checks for the ops metrics endpoint (v0.26.0).
 *
 *  pnpm test:metrics
 *
 *  - computeMetrics unit checks (pure, no API): decision counts by kind
 *    and reason code, POLICY_REPLACED entries excluded, rate-limit 429s
 *    by agent and kind, webhook deliveries by endpoint (including the
 *    `unknown` bucket for pre-v0.26.0 entries), hold-age math, malformed
 *    detail degrading gracefully, empty chain
 *  - booted-API integration (MOCK_RVN=true): fresh API reports zeros; an
 *    ALLOW issue, an over-cap DENY, and a held transfer land in the
 *    decision counts with the right reason codes; policy PUTs
 *    (POLICY_REPLACED) do not inflate the counts; approving the hold
 *    writes no new DECISION entry; a 1-op rate limit produces exactly one
 *    429 counted by agent and kind; two consecutive metrics reads report
 *    the same audit entry count (the read writes nothing); chain valid
 *  - webhook integration: a second API behind a stub receiver reports
 *    delivered counts per endpoint URL, then failed counts once the
 *    receiver goes down (each event retried, then audited as failed)
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { computeMetrics, UNKNOWN_ENDPOINT } from '../src/ops/metrics.js';
import type { AuditEntry } from '../src/audit.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3130;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2_PORT = 3131;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const STUB_PORT = 3132;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}/hook`;

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
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not come up in time');
}

function makeReq(base: string) {
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
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
  };
  return {
    get: (path: string) => req('GET', path),
    post: (path: string, body: unknown) => req('POST', path, body),
    put: (path: string, body: unknown) => req('PUT', path, body),
  };
}

/** Fabricate an audit entry for the pure-function checks (hashes unused). */
function entry(
  seq: number,
  kind: AuditEntry['kind'],
  agentId: string,
  detail: Record<string, unknown>,
  atMs = 1_000_000 + seq * 1000,
): AuditEntry {
  return {
    seq, prevHash: 'x', hash: 'y', atMs, kind,
    intentId: `intent-${seq}`, agentId, detail,
  };
}

async function main(): Promise<void> {
  // ---- 0. computeMetrics unit checks (no API needed) ----
  const empty = computeMetrics([], [], 2_000_000, {
    storeKind: 'memory', chainValid: true, uptimeSeconds: 42,
  });
  check('empty chain: all counts zero, no pending hold, store reported',
    empty.decisions.total === 0 && empty.decisions.byKind.ALLOW === 0 &&
    empty.decisions.byKind.DENY === 0 && empty.rateLimit429s.total === 0 &&
    Object.keys(empty.webhooks.byEndpoint).length === 0 &&
    empty.approvals.pending === 0 && empty.approvals.oldestPendingAgeMs === null &&
    empty.approvals.oldestPendingIntentId === null &&
    empty.audit.entries === 0 && empty.audit.chainValid === true &&
    empty.store === 'memory' && empty.uptimeSeconds === 42, empty);

  const mixed = computeMetrics(
    [
      entry(0, 'DECISION', 'agent-a', { kind: 'ALLOW', op: 'issue_asset', reasonCodes: ['OK1', 'OK2'] }),
      entry(1, 'DECISION', 'agent-a', { kind: 'DENY', op: 'issue_asset', reasonCodes: ['ISSUE_CAP_EXCEEDED'] }),
      entry(2, 'DECISION', 'agent-b', { kind: 'DENY', op: 'transfer_asset', reasonCodes: ['RATE_LIMIT_EXCEEDED'] }),
      entry(3, 'DECISION', 'agent-b', { kind: 'POLICY_REPLACED', preset: 'balanced' }),
      entry(4, 'DECISION', 'agent-a', { kind: 'REQUIRE_APPROVAL', op: 'transfer_asset', reasonCodes: ['DESTINATION_NOT_ALLOWLISTED'] }),
      entry(5, 'WEBHOOK_DELIVERY', 'agent-a', { event: 'intent.decided', endpoint: STUB_URL }),
      entry(6, 'WEBHOOK_DELIVERY', 'agent-a', { event: 'intent.executed', endpoint: STUB_URL }),
      entry(7, 'WEBHOOK_DELIVERY_FAILED', 'agent-b', { event: 'intent.decided', endpoint: STUB_URL }),
      entry(8, 'WEBHOOK_DELIVERY_FAILED', 'agent-b', { event: 'intent.decided' }),
      entry(9, 'DECISION', 'agent-a', { kind: 42 as unknown as string, reasonCodes: 'nope' }),
      entry(10, 'DECISION', 'agent-a', { kind: 'ALLOW', op: 'issue_asset' }),
      entry(11, 'APPROVAL', 'agent-a', { approver: 'human' }),
    ],
    [
      { intent: { id: 'hold-old', agentId: 'agent-a', kind: 'transfer_asset', assetName: 'X', qtyBaseUnits: '1', destination: 'd', requestedAtMs: 1_999_000 } as never, decision: { intentId: 'hold-old', agentId: 'agent-a', kind: 'REQUIRE_APPROVAL', reasonCodes: [], decidedAtMs: 1_999_000, expiresAtMs: 2_999_000 } as never },
      { intent: { id: 'hold-new', agentId: 'agent-b', kind: 'issue_asset', assetName: 'Y', qtyBaseUnits: '1', destination: 'd', requestedAtMs: 1_999_500 } as never, decision: { intentId: 'hold-new', agentId: 'agent-b', kind: 'REQUIRE_APPROVAL', reasonCodes: [], decidedAtMs: 1_999_500, expiresAtMs: 2_999_500 } as never },
    ],
    2_000_000,
    { storeKind: 'postgres', chainValid: false, uptimeSeconds: 7.9 },
  );
  check('decision counts by kind (POLICY_REPLACED and non-string kind excluded)',
    mixed.decisions.total === 5 && mixed.decisions.byKind.ALLOW === 2 &&
    mixed.decisions.byKind.DENY === 2 && mixed.decisions.byKind.REQUIRE_APPROVAL === 1, mixed.decisions);
  check('reason codes counted per entry, malformed reasonCodes ignored',
    mixed.decisions.byReasonCode.OK1 === 1 && mixed.decisions.byReasonCode.OK2 === 1 &&
    mixed.decisions.byReasonCode.ISSUE_CAP_EXCEEDED === 1 &&
    mixed.decisions.byReasonCode.RATE_LIMIT_EXCEEDED === 1 &&
    mixed.decisions.byReasonCode.DESTINATION_NOT_ALLOWLISTED === 1 &&
    Object.keys(mixed.decisions.byReasonCode).length === 5, mixed.decisions.byReasonCode);
  check('rate-limit 429s by agent and kind',
    mixed.rateLimit429s.total === 1 && mixed.rateLimit429s.byAgent['agent-b'] === 1 &&
    mixed.rateLimit429s.byKind.transfer_asset === 1, mixed.rateLimit429s);
  check('webhook deliveries by endpoint, endpoint-less entries under unknown',
    mixed.webhooks.byEndpoint[STUB_URL]?.delivered === 2 &&
    mixed.webhooks.byEndpoint[STUB_URL]?.failed === 1 &&
    mixed.webhooks.byEndpoint[UNKNOWN_ENDPOINT]?.failed === 1 &&
    mixed.webhooks.byEndpoint[UNKNOWN_ENDPOINT]?.delivered === 0, mixed.webhooks);
  check('oldest pending hold is the earliest requestedAtMs, age in ms',
    mixed.approvals.pending === 2 && mixed.approvals.oldestPendingAgeMs === 1000 &&
    mixed.approvals.oldestPendingIntentId === 'hold-old' &&
    mixed.approvals.oldestPendingAgentId === 'agent-a', mixed.approvals);
  check('store kind, chain validity, and floored uptime pass through',
    mixed.store === 'postgres' && mixed.audit.chainValid === false &&
    mixed.audit.entries === 12 && mixed.uptimeSeconds === 7, mixed);

  // ---- 1. booted API: decisions, holds, 429s ----
  const api = await bootApi(API1_PORT);
  const { get, post, put } = makeReq(API1);
  try {
    const fresh = await get('/v1/metrics');
    check('fresh API metrics: zeros, memory store, valid empty chain',
      fresh.status === 200 && fresh.json?.decisions?.total === 0 &&
      fresh.json?.rateLimit429s?.total === 0 &&
      Object.keys(fresh.json?.webhooks?.byEndpoint ?? {}).length === 0 &&
      fresh.json?.approvals?.pending === 0 &&
      fresh.json?.approvals?.oldestPendingAgeMs === null &&
      fresh.json?.store === 'memory' && fresh.json?.audit?.entries === 0 &&
      fresh.json?.audit?.chainValid === true, fresh.json);

    const { address } = (await post('/v1/wallets', {})).json;
    const policy = await get('/v1/policies/agent-1');
    const putPolicy = await put('/v1/policies/agent-1', {
      ...policy.json, agentId: 'agent-1', allowedDestinations: [address],
    });
    check('policy allowlists the agent wallet', putPolicy.status === 200);
    const afterPut = await get('/v1/metrics');
    check('policy PUT (POLICY_REPLACED) does not inflate decision counts',
      afterPut.json?.decisions?.total === 0, afterPut.json?.decisions);

    const issue = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'METRICS1', qty: '1000', toAddress: address,
    });
    check('issue ALLOWs', issue.status === 200 && issue.json.decision?.kind === 'ALLOW', issue.json);
    const denied = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'METRICS2', qty: '500000', toAddress: address,
    });
    check('over-cap issue DENYs', denied.status === 403 && denied.json.decision?.kind === 'DENY', denied.json);
    const m1 = await get('/v1/metrics');
    check('decisions counted: 1 ALLOW, 1 DENY, ISSUE_CAP_EXCEEDED once',
      m1.json?.decisions?.total === 2 && m1.json?.decisions?.byKind?.ALLOW === 1 &&
      m1.json?.decisions?.byKind?.DENY === 1 &&
      m1.json?.decisions?.byReasonCode?.ISSUE_CAP_EXCEEDED === 1, m1.json?.decisions);

    const held = await post('/v1/assets/transfer', {
      agentId: 'agent-1', assetName: 'METRICS1', qty: '100', destination: 'mtest1stranger000001xxxxxxxxxxxx',
    });
    const heldId: string | undefined = held.json.intent?.id;
    check('transfer held for approval', held.status === 202 && !!heldId, held.json);
    const m2 = await get('/v1/metrics');
    check('hold counted as REQUIRE_APPROVAL with DESTINATION_NOT_ALLOWLISTED',
      m2.json?.decisions?.total === 3 &&
      m2.json?.decisions?.byKind?.REQUIRE_APPROVAL === 1 &&
      m2.json?.decisions?.byReasonCode?.DESTINATION_NOT_ALLOWLISTED === 1, m2.json?.decisions);
    check('oldest pending hold names the held intent and its agent, age sane',
      m2.json?.approvals?.pending === 1 &&
      m2.json?.approvals?.oldestPendingIntentId === heldId &&
      m2.json?.approvals?.oldestPendingAgentId === 'agent-1' &&
      typeof m2.json?.approvals?.oldestPendingAgeMs === 'number' &&
      m2.json.approvals.oldestPendingAgeMs >= 0 &&
      m2.json.approvals.oldestPendingAgeMs < 60_000, m2.json?.approvals);
    const approved = await post(`/v1/intents/${heldId}/approve`, { approver: 'tester' });
    check('approve executes', approved.status === 200 && !!approved.json.txid, approved.json);
    const m3 = await get('/v1/metrics');
    check('approving a hold writes no new DECISION entry (counts unchanged, pending 0)',
      m3.json?.decisions?.total === 3 && m3.json?.approvals?.pending === 0 &&
      m3.json?.approvals?.oldestPendingAgeMs === null, m3.json);

    // Rate-limit 429s: a 1-op bucket for a fresh agent.
    const rlPolicy = await get('/v1/policies/metrics-rl');
    const rlPut = await put('/v1/policies/metrics-rl', {
      ...rlPolicy.json, agentId: 'metrics-rl', allowedDestinations: [address],
      rateLimitMaxOps: 1, rateLimitWindowSeconds: 3600,
    });
    check('rate-limit policy PUT 200s', rlPut.status === 200, rlPut.json);
    const rlFirst = await post('/v1/assets/issue', {
      agentId: 'metrics-rl', name: 'RLMETRIC', qty: '10', toAddress: address,
    });
    check('first issue inside the bucket ALLOWs', rlFirst.status === 200, rlFirst.json);
    const rlSecond = await post('/v1/assets/issue', {
      agentId: 'metrics-rl', name: 'RLMETRIC2', qty: '10', toAddress: address,
    });
    check('second issue 429s', rlSecond.status === 429 &&
      rlSecond.json.decision?.reasonCodes?.includes('RATE_LIMIT_EXCEEDED'), rlSecond.json);
    const m4 = await get('/v1/metrics');
    check('429 counted once, by agent and by kind, as a DENY with RATE_LIMIT_EXCEEDED',
      m4.json?.rateLimit429s?.total === 1 &&
      m4.json?.rateLimit429s?.byAgent?.['metrics-rl'] === 1 &&
      m4.json?.rateLimit429s?.byKind?.issue_asset === 1 &&
      m4.json?.decisions?.total === 5 && m4.json?.decisions?.byKind?.DENY === 2 &&
      m4.json?.decisions?.byReasonCode?.RATE_LIMIT_EXCEEDED === 1, m4.json);

    const m5a = await get('/v1/metrics');
    const m5b = await get('/v1/metrics');
    check('metrics reads are pure (same audit entry count across two reads)',
      m5a.json?.audit?.entries === m5b.json?.audit?.entries &&
      m5a.json?.decisions?.total === m5b.json?.decisions?.total, {
        a: m5a.json?.audit?.entries, b: m5b.json?.audit?.entries,
      });
    const audit = await get('/v1/audit?limit=200');
    check('audit chain valid after metrics operations', audit.json?.chainValid === true);
  } finally {
    api.kill();
  }

  // ---- 2. webhook deliveries by endpoint ----
  let stubFail = false;
  let stubCalls = 0;
  const stub = createServer((_req: IncomingMessage, res: ServerResponse) => {
    stubCalls++;
    res.writeHead(stubFail ? 500 : 200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  const api2 = await bootApi(API2_PORT, {
    RVN_WEBHOOKS_JSON: JSON.stringify([{ url: STUB_URL }]),
  });
  const api2req = makeReq(API2);
  try {
    const health = await api2req.get('/v1/health');
    check('webhook API reports 1 endpoint configured',
      health.json?.webhooks?.configured === true && health.json?.webhooks?.endpoints === 1, health.json?.webhooks);
    const { address } = (await api2req.post('/v1/wallets', {})).json;
    const policy = await api2req.get('/v1/policies/agent-1');
    await api2req.put('/v1/policies/agent-1', {
      ...policy.json, agentId: 'agent-1', allowedDestinations: [address],
    });
    const issue = await api2req.post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'WHMETRIC', qty: '100', toAddress: address,
    });
    check('webhook API issue ALLOWs', issue.status === 200, issue.json);
    const m = await api2req.get('/v1/metrics');
    check('delivered events counted per endpoint URL (decided + executed)',
      m.json?.webhooks?.byEndpoint?.[STUB_URL]?.delivered === 2 &&
      m.json?.webhooks?.byEndpoint?.[STUB_URL]?.failed === 0, m.json?.webhooks);
    stubFail = true;
    const callsBefore = stubCalls;
    const issue2 = await api2req.post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'WHMETRIC2', qty: '100', toAddress: address,
    });
    check('issue still ALLOWs while the receiver is down', issue2.status === 200, issue2.json);
    check('down receiver was retried (2 attempts per event, 2 events)',
      stubCalls - callsBefore === 4, stubCalls - callsBefore);
    const mFail = await api2req.get('/v1/metrics');
    check('failed deliveries counted per endpoint, delivered count unchanged',
      mFail.json?.webhooks?.byEndpoint?.[STUB_URL]?.delivered === 2 &&
      mFail.json?.webhooks?.byEndpoint?.[STUB_URL]?.failed === 2, mFail.json?.webhooks);
  } finally {
    api2.kill();
    stub.close();
  }

  console.log(failures === 0 ? 'metrics-test: all green' : `metrics-test: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
