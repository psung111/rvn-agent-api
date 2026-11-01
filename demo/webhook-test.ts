/**
 * webhook-test: checks for slices 1–3 of the Webhooks item.
 *
 *  pnpm test:webhooks
 *
 * Unit: env config parsing (single + multi-endpoint), payload shape, HMAC
 * signature, dispatcher retry / give-up / disabled behavior and
 * multi-endpoint routing with per-event subscriptions (all with injected
 * senders, no network). Integration: boots the real API as a child process
 * with RVN_WEBHOOK_URL pointing at a local stub, then drives issue / hold /
 * approve / deny / execution-failure flows and asserts the stub received
 * the right events, in order, with a verifiable signature — and that a
 * failing receiver never fails the API request itself — plus a second API
 * booted with RVN_WEBHOOKS_JSON proving per-endpoint event filtering.
 * Nothing touches the network beyond localhost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  buildWebhookPayload,
  DEFAULT_WEBHOOK_RETRY,
  retryDelayMs,
  signPayload,
  webhookConfigFromEnv,
  webhookConfigsFromEnv,
  webhookRetryFromEnv,
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
  path: string;
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
      stubCalls.push({ path: req.url ?? '', headers: req.headers, raw, body });
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
async function startApi(
  apiPort: number = API_PORT,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(apiPort),
      MOCK_RVN: 'true',
      RVN_WEBHOOK_URL: `http://127.0.0.1:${STUB_PORT}/hook`,
      RVN_WEBHOOK_SECRET: SECRET,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${apiPort}/v1/health`);
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

  // ===== unit: multi-endpoint config parsing =====
  const multi = webhookConfigsFromEnv({
    RVN_WEBHOOKS_JSON: JSON.stringify([
      { url: 'http://127.0.0.1:9/all' },
      { url: 'https://example.com/exec-only', secret: 's2', events: ['intent.executed'] },
      { url: 'ftp://example.com/bad' },
      { url: 'not a url' },
      { url: 'http://127.0.0.1:9/no-events', events: [] },
      { url: 'http://127.0.0.1:9/mixed-events', events: ['intent.denied', 'bogus-event'] },
      { notAUrl: true },
    ]),
    RVN_WEBHOOK_URL: 'http://127.0.0.1:9/legacy',
    RVN_WEBHOOK_SECRET: 'legacy-secret',
  });
  check('multi-endpoint parse keeps only valid entries (3 + legacy)',
    multi.length === 4 &&
      multi[0].url === 'http://127.0.0.1:9/all' && multi[0].events === undefined &&
      multi[1].secret === 's2' && multi[1].events?.length === 1 && multi[1].events[0] === 'intent.executed' &&
      multi[2].events?.length === 1 && multi[2].events[0] === 'intent.denied' &&
      multi[3].url === 'http://127.0.0.1:9/legacy' && multi[3].secret === 'legacy-secret',
    multi);
  check('malformed JSON list degrades to legacy only',
    webhookConfigsFromEnv({ RVN_WEBHOOKS_JSON: '{oops', RVN_WEBHOOK_URL: 'http://127.0.0.1:9/legacy' }).length === 1);
  check('non-array JSON list yields no list endpoints',
    webhookConfigsFromEnv({ RVN_WEBHOOKS_JSON: '{"url":"http://127.0.0.1:9/x"}' }).length === 0);
  check('empty env yields no endpoints', webhookConfigsFromEnv({}).length === 0);
  check('non-array events entry is skipped',
    webhookConfigsFromEnv({ RVN_WEBHOOKS_JSON: '[{"url":"http://127.0.0.1:9/x","events":"intent.decided"}]' }).length === 0);

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

  // ===== unit: multi-endpoint dispatcher =====
  const multiSent: Array<{ url: string; event: string; body: string; headers: Record<string, string> }> = [];
  const multiDispatcher = new WebhookDispatcher(
    [
      { url: 'http://127.0.0.1:9/all', secret: 'all-secret' },
      { url: 'http://127.0.0.1:9/exec-only', events: ['intent.executed'] },
    ],
    async (url, body, headers) => {
      multiSent.push({ url, event: headers['x-rvn-event'], body, headers });
      return { ok: true, status: 200 };
    },
  );
  check('multi dispatcher reports endpoint count', multiDispatcher.endpointCount === 2);
  const decidedCount = await multiDispatcher.deliver('intent.decided', intent);
  check('decided goes only to subscribed endpoints (1 of 2)',
    decidedCount === 1 && multiSent.length === 1 && multiSent[0].url === 'http://127.0.0.1:9/all',
    multiSent);
  check('per-endpoint secret signs its own deliveries',
    multiSent[0].headers['x-rvn-signature'] ===
      `sha256=${createHmac('sha256', 'all-secret').update(multiSent[0].body).digest('hex')}`);
  multiSent.length = 0;
  const executedCount = await multiDispatcher.deliver('intent.executed', intent, { txid: 'tx-9' });
  check('executed goes to both endpoints',
    executedCount === 2 && multiSent.length === 2 &&
      multiSent.some((s) => s.url === 'http://127.0.0.1:9/all') &&
      multiSent.some((s) => s.url === 'http://127.0.0.1:9/exec-only'),
    multiSent);
  check('unsubscribed endpoint sends no signature header',
    multiSent.find((s) => s.url === 'http://127.0.0.1:9/exec-only')?.headers['x-rvn-signature'] === undefined);

  const partialSent: string[] = [];
  const partial = new WebhookDispatcher(
    [
      { url: 'http://127.0.0.1:9/down' },
      { url: 'http://127.0.0.1:9/up' },
    ],
    async (url) => {
      if (url.endsWith('/up')) partialSent.push(url);
      return url.endsWith('/up') ? { ok: true, status: 200 } : { ok: false, status: 500 };
    },
  );
  let partialThrew = false;
  let partialError = '';
  try {
    await partial.deliver('intent.denied', intent);
  } catch (e) {
    partialThrew = true;
    partialError = (e as Error).message;
  }
  check('one failing endpoint does not block the other, and the error names it',
    partialThrew && partialSent.length === 1 && partialError.includes('http://127.0.0.1:9/down') &&
      !partialError.includes('secret'),
    partialError);

  const unsub = new WebhookDispatcher(
    [{ url: 'http://127.0.0.1:9/exec-only', events: ['intent.executed'] }],
    async () => { throw new Error('should not be called'); },
  );
  check('event with no subscribers attempts nothing and returns 0',
    (await unsub.deliver('intent.decided', intent)) === 0);

  // ===== unit: configurable retry/backoff (slice 3) =====
  check('retry defaults are 2 attempts / 500ms / factor 2 / 30s cap',
    JSON.stringify(webhookRetryFromEnv({})) === JSON.stringify(DEFAULT_WEBHOOK_RETRY),
    webhookRetryFromEnv({}));
  const customRetry = webhookRetryFromEnv({
    RVN_WEBHOOK_MAX_ATTEMPTS: '4',
    RVN_WEBHOOK_RETRY_DELAY_MS: '100',
    RVN_WEBHOOK_RETRY_BACKOFF_FACTOR: '3',
    RVN_WEBHOOK_RETRY_MAX_DELAY_MS: '5000',
  });
  check('retry env overrides parse',
    customRetry.maxAttempts === 4 && customRetry.baseDelayMs === 100 &&
      customRetry.backoffFactor === 3 && customRetry.maxDelayMs === 5000, customRetry);
  const badRetry = webhookRetryFromEnv({
    RVN_WEBHOOK_MAX_ATTEMPTS: '0',
    RVN_WEBHOOK_RETRY_DELAY_MS: '-5',
    RVN_WEBHOOK_RETRY_BACKOFF_FACTOR: '0',
    RVN_WEBHOOK_RETRY_MAX_DELAY_MS: 'not-a-number',
  });
  check('invalid retry env values fall back to defaults',
    JSON.stringify(badRetry) === JSON.stringify(DEFAULT_WEBHOOK_RETRY), badRetry);
  check('retry env values above the range fall back to defaults',
    webhookRetryFromEnv({ RVN_WEBHOOK_MAX_ATTEMPTS: '99' }).maxAttempts === 2);
  check('retry delay grows exponentially',
    retryDelayMs({ maxAttempts: 5, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 30000 }, 1) === 100 &&
      retryDelayMs({ maxAttempts: 5, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 30000 }, 2) === 200 &&
      retryDelayMs({ maxAttempts: 5, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 30000 }, 3) === 400);
  check('retry delay is capped at maxDelayMs',
    retryDelayMs({ maxAttempts: 5, baseDelayMs: 10000, backoffFactor: 10, maxDelayMs: 15000 }, 2) === 15000);
  check('retry delay with factor 1 stays flat',
    retryDelayMs({ maxAttempts: 5, baseDelayMs: 250, backoffFactor: 1, maxDelayMs: 30000 }, 3) === 250);
  const retryParsed = webhookConfigsFromEnv({
    RVN_WEBHOOKS_JSON: JSON.stringify([
      { url: 'http://127.0.0.1:9/r', maxAttempts: 4, retryDelayMs: 100, backoffFactor: 3, maxDelayMs: 9000 },
      { url: 'http://127.0.0.1:9/bad-r', maxAttempts: 0, retryDelayMs: -5, backoffFactor: 0 },
    ]),
  });
  check('per-endpoint retry overrides parse',
    retryParsed[0].retry?.maxAttempts === 4 && retryParsed[0].retry?.baseDelayMs === 100 &&
      retryParsed[0].retry?.backoffFactor === 3 && retryParsed[0].retry?.maxDelayMs === 9000, retryParsed);
  check('invalid per-endpoint retry fields are dropped, endpoint kept',
    retryParsed[1].retry === undefined, retryParsed[1]);

  const sleeps: number[] = [];
  let retryAttempts = 0;
  const retryDispatcher = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook' },
    async () => { retryAttempts++; return { ok: false, status: 500 }; },
    {
      retry: { maxAttempts: 4, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 30000 },
      sleep: async (ms) => { sleeps.push(ms); },
    },
  );
  let retryThrew = false;
  try {
    await retryDispatcher.deliver('intent.decided', intent);
  } catch {
    retryThrew = true;
  }
  check('global retry config drives attempt count and backoff delays',
    retryThrew && retryAttempts === 4 && JSON.stringify(sleeps) === JSON.stringify([100, 200, 400]), { retryAttempts, sleeps });

  const overrideSleeps: number[] = [];
  let overrideAttempts = 0;
  const overrideDispatcher = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook', retry: { maxAttempts: 3, baseDelayMs: 10, backoffFactor: 1 } },
    async () => { overrideAttempts++; return { ok: false, status: 500 }; },
    {
      retry: { maxAttempts: 2, baseDelayMs: 500, backoffFactor: 2, maxDelayMs: 30000 },
      sleep: async (ms) => { overrideSleeps.push(ms); },
    },
  );
  try {
    await overrideDispatcher.deliver('intent.decided', intent);
  } catch {
    // expected
  }
  check('per-endpoint retry overrides the global config',
    overrideAttempts === 3 && JSON.stringify(overrideSleeps) === JSON.stringify([10, 10]), { overrideAttempts, overrideSleeps });

  let oneAttempts = 0;
  const oneDispatcher = new WebhookDispatcher(
    { url: 'http://127.0.0.1:9/hook' },
    async () => { oneAttempts++; return { ok: false, status: 500 }; },
    {
      retry: { maxAttempts: 1, baseDelayMs: 100, backoffFactor: 2, maxDelayMs: 30000 },
      sleep: async () => { throw new Error('sleep must not be called with maxAttempts 1'); },
    },
  );
  try {
    await oneDispatcher.deliver('intent.decided', intent);
  } catch {
    // expected
  }
  check('maxAttempts 1 means no retry and no sleep', oneAttempts === 1);

  // ===== integration: the real API behind a stub receiver =====
  await startStub();
  const api = await startApi();
  try {
    const health = await get('/v1/health');
    check('health reports webhooks configured', health.webhooks?.configured === true && health.webhooks?.endpoints === 1, health.webhooks);

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

    // 7. Multi-endpoint integration: one endpoint gets everything, one
    //    only executed events — via RVN_WEBHOOKS_JSON, no legacy URL.
    const API2_PORT = 3127;
    const API2 = `http://127.0.0.1:${API2_PORT}`;
    const api2 = await startApi(API2_PORT, {
      RVN_WEBHOOK_URL: '',
      RVN_WEBHOOK_SECRET: '',
      RVN_WEBHOOKS_JSON: JSON.stringify([
        { url: `http://127.0.0.1:${STUB_PORT}/hook-all`, secret: SECRET },
        { url: `http://127.0.0.1:${STUB_PORT}/hook-exec-only`, events: ['intent.executed'] },
      ]),
    });
    try {
      const health2 = await (await fetch(`${API2}/v1/health`)).json() as any;
      check('health reports two webhook endpoints', health2.webhooks?.configured === true && health2.webhooks?.endpoints === 2, health2.webhooks);
      const post2 = async (path: string, body: unknown) => {
        const res = await fetch(`${API2}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() as any };
      };
      const { address: address2 } = (await post2('/v1/wallets', {})).json;
      const policy2 = await (await fetch(`${API2}/v1/policies/agent-1`)).json() as any;
      const put2 = await fetch(`${API2}/v1/policies/agent-1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...policy2, agentId: 'agent-1', allowedDestinations: [address2] }),
      });
      check('second API allowlists the agent wallet', put2.status === 200);
      const mark = stubCalls.length;
      const issue2 = await post2('/v1/assets/issue', {
        agentId: 'agent-1', name: 'MULTI', qty: '100', toAddress: address2,
      });
      check('multi-endpoint issue ALLOWs', issue2.status === 200 && issue2.json.decision?.kind === 'ALLOW', issue2.json);
      const newCalls = stubCalls.slice(mark);
      const allCalls = newCalls.filter((c) => c.path === '/hook-all');
      const execCalls = newCalls.filter((c) => c.path === '/hook-exec-only');
      check('all-events endpoint receives decided + executed',
        allCalls.length === 2 &&
          allCalls[0].headers['x-rvn-event'] === 'intent.decided' &&
          allCalls[1].headers['x-rvn-event'] === 'intent.executed',
        newCalls.map((c) => `${c.path}:${c.headers['x-rvn-event']}`));
      check('executed-only endpoint receives just the executed event',
        execCalls.length === 1 && execCalls[0].headers['x-rvn-event'] === 'intent.executed' &&
          execCalls[0].body?.txid === issue2.json.txid,
        execCalls.map((c) => `${c.path}:${c.headers['x-rvn-event']}`));
      check('multi-endpoint deliveries carry a valid signature',
        allCalls.every(signatureValid));
    } finally {
      api2.kill();
    }

    // 8. Retry config reaches the server from the environment (slice 3).
    const API3_PORT = 3128;
    const API3 = `http://127.0.0.1:${API3_PORT}`;
    const api3 = await startApi(API3_PORT, {
      RVN_WEBHOOK_MAX_ATTEMPTS: '3',
      RVN_WEBHOOK_RETRY_DELAY_MS: '100',
      RVN_WEBHOOK_RETRY_BACKOFF_FACTOR: '3',
    });
    try {
      const health3 = await (await fetch(`${API3}/v1/health`)).json() as any;
      check('health reports the configured retry options',
        health3.webhooks?.retry?.maxAttempts === 3 && health3.webhooks?.retry?.baseDelayMs === 100 &&
          health3.webhooks?.retry?.backoffFactor === 3, health3.webhooks);
    } finally {
      api3.kill();
    }
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
