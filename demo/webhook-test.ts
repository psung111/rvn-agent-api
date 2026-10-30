/**
 * webhook-test: checks for slice 1 of the Webhooks item.
 *
 *  pnpm test:webhooks
 *
 * Unit: env config parsing, payload shape, HMAC signature, dispatcher
 * retry / give-up / disabled behavior (all with injected senders, no
 * network). Integration: boots the real API as a child process with
 * RVN_WEBHOOK_URL pointing at a local stub, then drives issue / hold /
 * approve / deny / execution-failure flows and asserts the stub received
 * the right events, in order, with a verifiable signature — and that a
 * failing receiver never fails the API request itself.
 * Nothing touches the network beyond localhost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  buildWebhookPayload,
  signPayload,
  webhookConfigFromEnv,
  WebhookDispatcher,
} from '../src/webhooks/dispatcher.js';
import type { RvnIntent } from '../src/policy/types.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3125;
const STUB_PORT = 3126;
const API = `http://127.0.0.1:${API_PORT}`;
const SECRET = 'test-webhook-secret';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

const intent: RvnIntent = {
  id: 'intent-webhook-1',
  agentId: 'agent-1',
  kind: 'issue_asset',
  assetName: 'WEBCOIN',
  qtyBaseUnits: '1000',
  destination: 'mtest1wallet00000000000000000000',
  requestedAtMs: Date.now(),
};

// ---- local stub webhook receiver ----
interface StubCall {
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: any;
}
const stubCalls: StubCall[] = [];
let stubFail = false;
let stub: Server;

async function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { parseError: raw.slice(0, 100) };
      }
      stubCalls.push({ headers: req.headers, raw, body });
      if (stubFail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'receiver down' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
}

// ---- helpers for driving the API ----
async function startApi(): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MOCK_RVN: 'true',
      RVN_WEBHOOK_URL: `http://127.0.0.1:${STUB_PORT}/hook`,
      RVN_WEBHOOK_SECRET: SECRET,
    },
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

async function get(path: string) {
  return (await (await fetch(`${API}${path}`)).json()) as any;
}

function callsFor(event: string) {
  return stubCalls.filter((c) => c.headers['x-rvn-event'] === event);
}

function signatureValid(call: StubCall): boolean {
  const expected = `sha256=${createHmac('sha256', SECRET).update(call.raw).digest('hex')}`;
  return call.headers['x-rvn-signature'] === expected;
}

async function main() {
  // ===== unit: config parsing =====
  check('missing URL disables webhooks', webhookConfigFromEnv({}) === null);
  check(
    'http URL parses with secret',
    webhookConfigFromEnv({ RVN_WEBHOOK_URL: 'https://example.com/hook', RVN_WEBHOOK_SECRET: 's' })?.secret === 's',
  );
  check(
    'non-http protocol disables webhooks',
    webhookConfigFromEnv({ RVN_WEBHOOK_URL: 'ftp://example.com/hook' }) === null,
  );
  check(
    'malformed URL disables webhooks, no crash',
    webhookConfigFromEnv({ RVN_WEBHOOK_URL: 'not a url' }) === null,
  );
  check(
    'secret optional when URL present',
    webhookConfigFromEnv({ RVN_WEBHOOK_URL: 'http://127.0.0.1:9/hook' })?.secret === undefined,
  );

  // ===== unit: payload + signature =====
  const payload = buildWebhookPayload('intent.decided', intent, {
    decision: {
      intentId: intent.id, agentId: intent.agentId, kind: 'ALLOW',
      reasonCodes: ['WITHIN_POLICY'], decidedAtMs: 0, expiresAtMs: 1,
    },
  });
  check('payload carries event/version/intent facts', payload.event === 'intent.decided' && payload.version === 1 &&
    payload.intent.assetName === 'WEBCOIN' && payload.intent.qtyBaseUnits === '1000' &&
    payload.decision?.kind === 'ALLOW');
  check('payload never carries the secret', !JSON.stringify(payload).includes(SECRET));
  const body = JSON.stringify(payload);
  check('signature is deterministic', signPayload(SECRET, body) === signPayload(SECRET, body));
  check('signature changes with the body', signPayload(SECRET, body) !== signPayload(SECRET, `${body} `));
  check(
    'signature verifies against node crypto',
    signPayload(SECRET, body) === `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
  );

  // ===== unit: dispatcher with injected senders =====
  let sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const okDispatcher = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook', secret: SECRET },
    async (url, _b, headers) => { sent.push({ url, headers }); return { ok: true, status: 200 }; },
  );
  check('dispatcher reports enabled when configured', okDispatcher.enabled === true);
  await okDispatcher.deliver('intent.decided', intent);
  check('dispatcher POSTs to the configured URL', sent.length === 1 && sent[0].url === 'http://127.0.0.1:9/hook');
  check('dispatcher sets the event header', sent[0].headers['x-rvn-event'] === 'intent.decided');
  check('dispatcher signs when a secret is set', typeof sent[0].headers['x-rvn-signature'] === 'string' &&
    sent[0].headers['x-rvn-signature'].startsWith('sha256='));

  sent = [];
  const noSecretDispatcher = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook' },
    async (url, _b, headers) => { sent.push({ url, headers }); return { ok: true, status: 200 }; },
  );
  await noSecretDispatcher.deliver('intent.executed', intent, { txid: 'tx-1' });
  check('no signature header without a secret', sent[0].headers['x-rvn-signature'] === undefined);

  let attempts = 0;
  const flaky = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook' },
    async () => { attempts++; return attempts === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }; },
  );
  await flaky.deliver('intent.decided', intent);
  check('dispatcher retries once after a failure', attempts === 2);

  attempts = 0;
  const down = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook' },
    async () => { attempts++; return { ok: false, status: 500 }; },
  );
  let threw = false;
  try {
    await down.deliver('intent.decided', intent);
  } catch {
    threw = true;
  }
  check('dispatcher throws after two failed attempts', threw && attempts === 2);

  let disabledCalls = 0;
  const disabled = new WebhookDispatcher(null, async () => { disabledCalls++; return { ok: true, status: 200 }; });
  check('disabled dispatcher reports enabled=false', disabled.enabled === false);
  await disabled.deliver('intent.decided', intent);
  check('disabled dispatcher sends nothing', disabledCalls === 0);

  // ===== integration: the real API behind a stub receiver =====
  await startStub();
  const api = await startApi();
  try {
    const health = await get('/v1/health');
    check('health reports webhooks configured', health.webhooks?.configured === true);

    const { address } = (await post('/v1/wallets', {})).json;
    const policy = await get('/v1/policies/agent-1');
    const putPolicy = await fetch(`${API}/v1/policies/agent-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...policy, agentId: 'agent-1', allowedDestinations: [address] }),
    });
    check('policy allowlists the agent wallet', putPolicy.status === 200);

    // 1. ALLOW issue -> decided + executed, signature valid
    const before = stubCalls.length;
    const issue = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'WEBCOIN', qty: '1000', toAddress: address,
    });
    check('setup issue ALLOWs', issue.status === 200 && issue.json.decision?.kind === 'ALLOW', issue.json);
    const issueCalls = stubCalls.slice(before);
    check(
      'ALLOW issue emits decided then executed',
      issueCalls.length === 2 &&
        issueCalls[0].headers['x-rvn-event'] === 'intent.decided' &&
        issueCalls[1].headers['x-rvn-event'] === 'intent.executed',
      issueCalls.map((c) => c.headers['x-rvn-event']),
    );
    check('decided payload names the decision', issueCalls[0]?.body?.decision?.kind === 'ALLOW' &&
      issueCalls[0]?.body?.intentId === issue.json.intent?.id);
    check('executed payload carries the txid', issueCalls[1]?.body?.txid === issue.json.txid);
    check('deliveries carry a valid HMAC signature', issueCalls.every(signatureValid));
    check('delivery bodies carry no secret', !JSON.stringify(issueCalls).includes(SECRET));

    // 2. DENY issue -> decided only, no executed
    const beforeDeny = stubCalls.length;
    const denied = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'WEBCOIN2', qty: '500000', toAddress: address,
    });
    check('over-cap issue DENYs', denied.status === 403 && denied.json.decision?.kind === 'DENY');
    const denyCalls = stubCalls.slice(beforeDeny);
    check('DENY emits decided only', denyCalls.length === 1 && denyCalls[0].headers['x-rvn-event'] === 'intent.decided' &&
      denyCalls[0].body?.decision?.kind === 'DENY');

    // 3. Hold -> decided REQUIRE_APPROVAL, then approve -> executed
    const held = await post('/v1/assets/transfer', {
      agentId: 'agent-1', assetName: 'WEBCOIN', qty: '100', destination: 'mtest1stranger000001xxxxxxxxxxxx',
    });
    const heldId: string | undefined = held.json.intent?.id;
    check('transfer held for approval', held.status === 202 && !!heldId, held.json);
    const holdDecided = callsFor('intent.decided').filter((c) => c.body?.intentId === heldId);
    check('hold emits decided REQUIRE_APPROVAL', holdDecided.length === 1 &&
      holdDecided[0].body?.decision?.kind === 'REQUIRE_APPROVAL');
    check('no executed event before approval', !callsFor('intent.executed').some((c) => c.body?.intentId === heldId));
    const approved = await post(`/v1/intents/${heldId}/approve`, { approver: 'tester' });
    check('approve executes', approved.status === 200 && !!approved.json.txid, approved.json);
    check('approve emits executed with the txid',
      callsFor('intent.executed').some((c) => c.body?.intentId === heldId && c.body?.txid === approved.json.txid));

    // 4. Deny a held intent -> denied event
    const held2 = await post('/v1/assets/transfer', {
      agentId: 'agent-1', assetName: 'WEBCOIN', qty: '50', destination: 'mtest1stranger000001xxxxxxxxxxxx',
    });
    const heldId2: string | undefined = held2.json.intent?.id;
    const deniedRes = await post(`/v1/intents/${heldId2}/deny`, { approver: 'tester' });
    check('deny resolves', deniedRes.status === 200 && deniedRes.json?.denied === true);
    check('deny emits intent.denied',
      callsFor('intent.denied').some((c) => c.body?.intentId === heldId2 &&
        c.body?.decision?.reasonCodes?.includes('DENIED_BY_OWNER')));

    // 5. Execution failure (duplicate asset) -> decided + execution_failed, 502
    const beforeFail = stubCalls.length;
    const dup = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'WEBCOIN', qty: '100', toAddress: address,
    });
    check('duplicate issue returns 502', dup.status === 502, dup.json);
    const failCalls = stubCalls.slice(beforeFail);
    check('execution failure emits decided + execution_failed',
      failCalls.length === 2 &&
        failCalls[0].headers['x-rvn-event'] === 'intent.decided' &&
        failCalls[1].headers['x-rvn-event'] === 'intent.execution_failed' &&
        String(failCalls[1].body?.error).includes('already exists'),
      failCalls.map((c) => c.headers['x-rvn-event']));

    // 6. A failing receiver never fails the request; failures are audited
    stubFail = true;
    const failBefore = stubCalls.length;
    const okDespiteDown = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'WEBCOIN3', qty: '100', toAddress: address,
    });
    check('issue still ALLOWs while the receiver is down (200)',
      okDespiteDown.status === 200 && okDespiteDown.json.decision?.kind === 'ALLOW', okDespiteDown.json);
    check('receiver was retried (2 attempts per event)',
      stubCalls.length - failBefore === 4, stubCalls.length - failBefore);
    const audit = await get('/v1/audit?limit=50');
    check(
      'audit records WEBHOOK_DELIVERY_FAILED for the down receiver',
      audit.chainValid === true &&
        audit.entries?.some((e: any) => e.kind === 'WEBHOOK_DELIVERY_FAILED' &&
          e.intentId === okDespiteDown.json.intent?.id),
    );
    check(
      'audit records successful deliveries too',
      audit.entries?.some((e: any) => e.kind === 'WEBHOOK_DELIVERY' && e.intentId === issue.json.intent?.id),
    );
    stubFail = false;
  } finally {
    api.kill();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all webhook checks passed');
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
