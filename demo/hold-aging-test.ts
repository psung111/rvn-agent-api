/**
 * hold-aging-test: checks for the Hold-aging alerts item (v0.34.0).
 *
 *  pnpm test:hold-aging
 *
 * Unit: env config parsing, age formatting, due/once-per-hold logic,
 * quorum progress in the payload, the aging message, and the sweep worker
 * with injected fakes (channel failures, mark failure retries, no
 * double-alert). Integration: boots the real API as a child process with
 * a 1.5s alert threshold and a 1s sweep, a local stub standing in for
 * api.telegram.org (via TELEGRAM_API_BASE_URL) and a stub webhook
 * receiver, then drives a hold past the threshold and asserts the
 * Telegram reminder + the intent.hold_aging webhook event fire exactly
 * once, the HOLD_AGING_ALERT audit entry lands, and approving the hold
 * clears it — plus a quorum hold whose payload reports 0/2. Nothing
 * touches the network beyond localhost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  checkHoldAging,
  DEFAULT_HOLD_AGING,
  formatAgeMs,
  holdAgingConfigFromEnv,
  holdAgingInfoOf,
  isHoldAgingDue,
  quorumProgressOf,
  type HoldAgingDeps,
} from '../src/approvals/hold-aging.js';
import { formatHoldAgingMessage } from '../src/approvals/notifier.js';
import { buildWebhookPayload } from '../src/webhooks/dispatcher.js';
import type { Decision, RvnIntent } from '../src/policy/types.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3140;
const WEBHOOK_PORT = 3141;
const TG_PORT = 3142;
const API = `http://127.0.0.1:${API_PORT}`;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

const baseIntent: RvnIntent = {
  id: 'intent-hold-aging-1',
  agentId: 'agent-1',
  kind: 'transfer_asset',
  assetName: 'HOLDCOIN',
  qtyBaseUnits: '100',
  destination: 'mtest1wallet00000000000000000000',
  requestedAtMs: 1000,
};

function baseDecision(over: Partial<Decision> = {}): Decision {
  return {
    intentId: baseIntent.id,
    agentId: 'agent-1',
    kind: 'REQUIRE_APPROVAL',
    reasonCodes: ['UNKNOWN_DESTINATION'],
    decidedAtMs: 1000,
    expiresAtMs: 1000 + 3600_000,
    ...over,
  };
}

// ---- fake deps for the sweep worker ----
interface FakeCalls {
  notified: Array<{ intent: RvnIntent; decision: Decision; ageMs: number }>;
  webhooks: Array<{ event: string; intent: RvnIntent; extra: unknown }>;
  audits: Array<{ kind: string; intentId: string; agentId: string; detail: Record<string, unknown> }>;
  marked: Array<{ intentId: string; decision: Decision }>;
  logs: string[];
}

function fakeDeps(
  pending: Array<{ intent: RvnIntent; decision: Decision }>,
  fail?: { notify?: boolean; webhook?: boolean; mark?: boolean; audit?: boolean },
): { deps: HoldAgingDeps; calls: FakeCalls } {
  const calls: FakeCalls = { notified: [], webhooks: [], audits: [], marked: [], logs: [] };
  const deps: HoldAgingDeps = {
    pending,
    notifyAging: async (intent, decision, ageMs) => {
      if (fail?.notify) throw new Error('telegram down');
      calls.notified.push({ intent, decision, ageMs });
    },
    deliverWebhook: async (event, intent, extra) => {
      if (fail?.webhook) throw new Error('receiver down');
      calls.webhooks.push({ event, intent, extra });
    },
    audit: async (kind, intentId, agentId, detail) => {
      if (fail?.audit) throw new Error('audit down');
      calls.audits.push({ kind, intentId, agentId, detail });
      return { seq: 1 } as never;
    },
    markAlerted: async (intentId, decision) => {
      if (fail?.mark) throw new Error('store down');
      calls.marked.push({ intentId, decision });
    },
    log: (message) => calls.logs.push(message),
  };
  return { deps, calls };
}

async function unitChecks(): Promise<void> {
  // ---- config parsing ----
  check('defaults: 1h alert, 60s sweep', holdAgingConfigFromEnv({}).alertAfterMs === 3600000 &&
    holdAgingConfigFromEnv({}).checkIntervalMs === 60000, holdAgingConfigFromEnv({}));
  check('DEFAULT_HOLD_AGING matches', DEFAULT_HOLD_AGING.alertAfterMs === 3600000 &&
    DEFAULT_HOLD_AGING.checkIntervalMs === 60000);
  check('valid values parse', (() => {
    const c = holdAgingConfigFromEnv({ RVN_HOLD_ALERT_AFTER_MS: '5000', RVN_HOLD_ALERT_CHECK_MS: '2000' });
    return c.alertAfterMs === 5000 && c.checkIntervalMs === 2000;
  })());
  check('non-numeric falls back', holdAgingConfigFromEnv({ RVN_HOLD_ALERT_AFTER_MS: 'soon' }).alertAfterMs === 3600000);
  check('below-min falls back', holdAgingConfigFromEnv({ RVN_HOLD_ALERT_AFTER_MS: '0' }).alertAfterMs === 3600000);
  check('above-max falls back', holdAgingConfigFromEnv({ RVN_HOLD_ALERT_AFTER_MS: '99999999999' }).alertAfterMs === 3600000);
  check('fractional falls back', holdAgingConfigFromEnv({ RVN_HOLD_ALERT_CHECK_MS: '1.5' }).checkIntervalMs === 60000);
  check('max values accepted', (() => {
    const c = holdAgingConfigFromEnv({
      RVN_HOLD_ALERT_AFTER_MS: String(7 * 24 * 3600 * 1000),
      RVN_HOLD_ALERT_CHECK_MS: String(3600 * 1000),
    });
    return c.alertAfterMs === 7 * 24 * 3600 * 1000 && c.checkIntervalMs === 3600 * 1000;
  })());

  // ---- age formatting ----
  check('format 0s', formatAgeMs(0) === '0s');
  check('format 45s', formatAgeMs(45000) === '45s');
  check('format 90s -> 1m', formatAgeMs(90000) === '1m');
  check('format 5m', formatAgeMs(300000) === '5m');
  check('format 65m -> 1h 5m', formatAgeMs(65 * 60000) === '1h 5m');
  check('format 2h exact', formatAgeMs(2 * 3600000) === '2h');
  check('format 25h -> 1d 1h', formatAgeMs(25 * 3600000) === '1d 1h');
  check('format 48h -> 2d', formatAgeMs(48 * 3600000) === '2d');

  // ---- due logic ----
  const now = 1000 + 3600000;
  check('young hold not due', !isHoldAgingDue(baseDecision(), 3600000, 1000 + 59999));
  check('old hold due', isHoldAgingDue(baseDecision(), 3600000, now));
  check('exactly at threshold due', isHoldAgingDue(baseDecision(), 3600000, 1000 + 3600000));
  check('already-alerted hold not due', !isHoldAgingDue(baseDecision({ holdAlertedAtMs: 2000 }), 3600000, now));
  check('ALLOW decision never due', !isHoldAgingDue(baseDecision({ kind: 'ALLOW' }), 1, now));
  check('DENY decision never due', !isHoldAgingDue(baseDecision({ kind: 'DENY' }), 1, now));

  // ---- quorum progress ----
  check('no quorum -> no progress', quorumProgressOf(baseDecision()) === undefined);
  check('quorum progress without roster', (() => {
    const q = quorumProgressOf(baseDecision({ quorumRequired: 2, approvals: ['alice'] }));
    return q?.approvalsReceived === 1 && q?.approvalsRequired === 2 && q?.approversTotal === undefined;
  })());
  check('quorum progress with roster reports M', (() => {
    const q = quorumProgressOf(
      baseDecision({ quorumRequired: 2, approvals: ['alice'], quorumApprovers: ['alice', 'bob', 'carol'] }),
    );
    return q?.approvalsReceived === 1 && q?.approvalsRequired === 2 && q?.approversTotal === 3;
  })());
  check('holdAgingInfoOf carries age + quorum', (() => {
    const info = holdAgingInfoOf(baseDecision({ quorumRequired: 2, approvals: ['alice'] }), 5000);
    return info.ageMs === 5000 && info.quorum?.approvalsReceived === 1 && info.quorum?.approvalsRequired === 2;
  })());
  check('holdAgingInfoOf without quorum has no quorum key', (() => {
    const info = holdAgingInfoOf(baseDecision(), 5000);
    return info.ageMs === 5000 && info.quorum === undefined;
  })());

  // ---- webhook payload shape for the new event ----
  const payload = buildWebhookPayload('intent.hold_aging', baseIntent, {
    decision: baseDecision(),
    holdAging: { ageMs: 5000, quorum: { approvalsReceived: 1, approvalsRequired: 2, approversTotal: 3 } },
  });
  check('hold_aging payload carries age + quorum', payload.event === 'intent.hold_aging' &&
    payload.holdAging?.ageMs === 5000 && payload.holdAging?.quorum?.approvalsReceived === 1 &&
    payload.holdAging?.quorum?.approversTotal === 3 && payload.decision?.kind === 'REQUIRE_APPROVAL', payload);

  // ---- aging message ----
  const msg = formatHoldAgingMessage(baseIntent, baseDecision(), 65 * 60000);
  check('aging message names the hold + age', msg.includes('Still waiting') && msg.includes('1h 5m') &&
    msg.includes(baseIntent.id) && msg.includes('UNKNOWN_DESTINATION'), msg);
  check('aging message has no quorum line without quorum', !msg.includes('approvals:'));
  const qmsg = formatHoldAgingMessage(
    baseIntent,
    baseDecision({ quorumRequired: 2, approvals: ['alice'], quorumApprovers: ['alice', 'bob', 'carol'] }),
    3600000,
  );
  check('aging message reports 1/2 of 3', qmsg.includes('approvals: 1/2 of 3'), qmsg);
  check('aging message keeps the approve curl', msg.includes(`/v1/intents/${baseIntent.id}/approve`));

  // ---- sweep worker ----
  const config = { alertAfterMs: 3600000, checkIntervalMs: 60000 };
  {
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: baseDecision() }]);
    const r = await checkHoldAging(config, deps, 1000 + 59999);
    check('young hold: nothing fires', r.alerted.length === 0 && calls.notified.length === 0 &&
      calls.webhooks.length === 0 && calls.audits.length === 0 && calls.marked.length === 0, r);
  }
  {
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: baseDecision() }]);
    const r = await checkHoldAging(config, deps, now);
    check('old hold: alerts once', r.alerted.length === 1 && r.alerted[0] === baseIntent.id, r);
    check('old hold: Telegram notified with age', calls.notified.length === 1 &&
      calls.notified[0].ageMs === 3600000, calls.notified);
    check('old hold: webhook intent.hold_aging with age', calls.webhooks.length === 1 &&
      calls.webhooks[0].event === 'intent.hold_aging' &&
      (calls.webhooks[0].extra as any).holdAging?.ageMs === 3600000, calls.webhooks);
    check('old hold: audited HOLD_AGING_ALERT', calls.audits.length === 1 &&
      calls.audits[0].kind === 'HOLD_AGING_ALERT' && calls.audits[0].detail.ageMs === 3600000 &&
      calls.audits[0].detail.notified === true, calls.audits);
    check('old hold: marked alerted with timestamp', calls.marked.length === 1 &&
      calls.marked[0].decision.holdAlertedAtMs === now, calls.marked);
  }
  {
    // A second sweep over the marked decision alerts nothing — once per hold.
    const marked = baseDecision({ holdAlertedAtMs: now });
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: marked }]);
    const r = await checkHoldAging(config, deps, now + 3600000);
    check('already-alerted hold: second sweep silent', r.alerted.length === 0 && calls.notified.length === 0 &&
      calls.webhooks.length === 0 && calls.audits.length === 0, r);
  }
  {
    const qDecision = baseDecision({ quorumRequired: 2, approvals: ['alice'], quorumApprovers: ['alice', 'bob', 'carol'] });
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: qDecision }]);
    await checkHoldAging(config, deps, now);
    check('quorum hold: webhook payload carries 1/2 of 3', (() => {
      const q = (calls.webhooks[0]?.extra as any)?.holdAging?.quorum;
      return q?.approvalsReceived === 1 && q?.approvalsRequired === 2 && q?.approversTotal === 3;
    })(), calls.webhooks);
    check('quorum hold: audit carries quorum counts', calls.audits[0]?.detail.approvalsReceived === 1 &&
      calls.audits[0]?.detail.approvalsRequired === 2 && calls.audits[0]?.detail.approversTotal === 3, calls.audits);
  }
  {
    // A failing notifier must not block the webhook, the audit, or the flag.
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: baseDecision() }], { notify: true });
    const r = await checkHoldAging(config, deps, now);
    check('notifier failure: webhook + audit + mark still happen', r.alerted.length === 1 &&
      calls.webhooks.length === 1 && calls.audits.length === 1 && calls.marked.length === 1 &&
      calls.audits[0].detail.notified === false && calls.logs.length === 1, calls);
  }
  {
    // A failing webhook must not block the notifier, the audit, or the flag.
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: baseDecision() }], { webhook: true });
    const r = await checkHoldAging(config, deps, now);
    check('webhook failure: notify + audit + mark still happen', r.alerted.length === 1 &&
      calls.notified.length === 1 && calls.audits.length === 1 && calls.marked.length === 1, calls);
  }
  {
    // A failing mark means the alert is NOT counted — the next sweep retries.
    const { deps, calls } = fakeDeps([{ intent: baseIntent, decision: baseDecision() }], { mark: true });
    const r = await checkHoldAging(config, deps, now);
    check('mark failure: not counted, no audit, retried next sweep', r.alerted.length === 0 &&
      calls.audits.length === 0 && calls.logs.length === 1, r);
  }
  {
    const { deps } = fakeDeps([]);
    const r = await checkHoldAging(config, deps, now);
    check('empty pending: checked 0, alerted none', r.checked === 0 && r.alerted.length === 0, r);
  }
}

// ---- integration: stubs + booted API ----
interface StubCall {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: any;
}
const webhookCalls: StubCall[] = [];
const tgCalls: Array<{ method: string; body: any }> = [];
let webhookStub: Server;
let tgStub: Server;

async function startStubs(): Promise<void> {
  webhookStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { parseError: raw.slice(0, 100) };
      }
      webhookCalls.push({ path: req.url ?? '', headers: req.headers, raw, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => webhookStub.listen(WEBHOOK_PORT, '127.0.0.1', resolve));

  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const m = /^\/bot[^/]+\/(\w+)$/.exec(url);
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { parseError: raw.slice(0, 100) };
      }
      tgCalls.push({ method: m?.[1] ?? url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise<void>((resolve) => tgStub.listen(TG_PORT, '127.0.0.1', resolve));
}

let api: ChildProcess | null = null;

async function bootApi(): Promise<void> {
  api = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MOCK_RVN: 'true',
      RVN_HOLD_ALERT_AFTER_MS: '1500',
      RVN_HOLD_ALERT_CHECK_MS: '1000',
      TELEGRAM_APPROVAL_BOT_TOKEN: 'test-token',
      TELEGRAM_APPROVAL_CHAT_ID: '111',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${TG_PORT}`,
      RVN_WEBHOOK_URL: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', () => {});
  api.stderr?.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${API}/v1/health`);
      if (r.ok) return;
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

function holdAgingEvents() {
  return webhookCalls.filter((c) => c.body?.event === 'intent.hold_aging');
}

async function waitForHoldAging(count: number, timeoutMs = 9000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (holdAgingEvents().length >= count) return true;
    await sleep(250);
  }
  return holdAgingEvents().length >= count;
}

function tgSends() {
  return tgCalls.filter((c) => c.method === 'sendMessage');
}

async function integrationChecks(): Promise<void> {
  await startStubs();
  try {
    await bootApi();

    const health = await get('/v1/health');
    check('health reports holdAging config', health.json?.holdAging?.alertAfterMs === 1500 &&
      health.json?.holdAging?.checkIntervalMs === 1000 && health.json?.holdAging?.enabled === true, health.json?.holdAging);

    // Issue the asset first so the held transfer can actually execute on
    // approval (the mock node refuses transfers of unknown assets).
    // Per-address asset balances (v0.42.0): the transfer executes from
    // the agent's own wallet address, so the coin is issued to it — a
    // throwaway destination would leave the agent's address holding
    // none of it and the approval-time funding gate would refuse it.
    const address = (await get('/v1/wallet/address/agent-1')).json?.address as string;
    const basePolicy = await get('/v1/policies/agent-1');
    const allowlisted = await put('/v1/policies/agent-1', {
      ...basePolicy.json,
      agentId: 'agent-1',
      allowedDestinations: [address],
    });
    check('allowlist the agent wallet', allowlisted.status === 200, allowlisted.json);
    const issued = await post('/v1/assets/issue', {
      agentId: 'agent-1', name: 'HOLDCOIN', qty: '1000', toAddress: address,
    });
    check('issue HOLDCOIN for the transfer test', issued.status === 200 &&
      issued.json?.decision?.kind === 'ALLOW', issued.json);

    // A transfer to an unknown destination holds (empty allowlist for it).
    const held = await post('/v1/assets/transfer', {
      agentId: 'agent-1', assetName: 'HOLDCOIN', qty: '100', destination: 'munknown00000000000000000000000',
    });
    check('transfer to unknown destination holds (202)', held.status === 202 &&
      held.json?.decision?.kind === 'REQUIRE_APPROVAL', held.json);
    const holdId = held.json?.intent?.id as string;
    check('hold posted one Telegram sendMessage', tgSends().length === 1, tgSends().length);

    check('hold_aging fires within the window', await waitForHoldAging(1), holdAgingEvents().length);
    const event = holdAgingEvents()[0]?.body;
    check('hold_aging event carries the hold id + age >= threshold', event?.intentId === holdId &&
      typeof event?.holdAging?.ageMs === 'number' && event.holdAging.ageMs >= 1500, event);
    check('hold_aging event carries no quorum without one', event?.holdAging?.quorum === undefined, event?.holdAging);
    check('hold_aging event carries the REQUIRE_APPROVAL decision', event?.decision?.kind === 'REQUIRE_APPROVAL', event?.decision);
    check('reminder sendMessage posted once', tgSends().length === 2, tgSends().length);
    check('reminder text names the hold + age', tgSends()[1]?.body?.text?.includes('Still waiting') &&
      tgSends()[1]?.body?.text?.includes(holdId), tgSends()[1]?.body?.text);
    check('reminder keeps the Approve/Deny buttons', Array.isArray(
      tgSends()[1]?.body?.reply_markup?.inline_keyboard?.[0]) &&
      tgSends()[1].body.reply_markup.inline_keyboard[0].length === 2, tgSends()[1]?.body?.reply_markup);

    const audit = await get('/v1/audit?limit=200');
    const agingEntry = (audit.json?.entries as any[] | undefined)?.find((e) => e.kind === 'HOLD_AGING_ALERT');
    check('HOLD_AGING_ALERT audited with age + notified', agingEntry?.intentId === holdId &&
      typeof agingEntry?.detail?.ageMs === 'number' && agingEntry.detail.ageMs >= 1500 &&
      agingEntry?.detail?.notified === true, agingEntry);
    check('audit chain still valid', audit.json?.chainValid === true, audit.json?.chainValid);

    const pending = await get('/v1/intents/pending');
    check('hold still pending after the alert', (pending.json?.pending as any[])?.some((p) => p.intent?.id === holdId), pending.json);

    // Once per hold: another two seconds of sweeps must not re-alert.
    await sleep(2000);
    check('no second hold_aging event after more sweeps', holdAgingEvents().length === 1, holdAgingEvents().length);
    check('no second reminder sendMessage', tgSends().length === 2, tgSends().length);

    // Approving clears the alert: no further event after the hold resolves.
    const approved = await post(`/v1/intents/${holdId}/approve`, { approver: 'alice' });
    check('hold approves and executes', approved.status === 200 && typeof approved.json?.txid === 'string', approved.json);
    await sleep(1500);
    check('no hold_aging event after approval', holdAgingEvents().length === 1, holdAgingEvents().length);

    // Quorum hold: payload reports 0/2.
    const policy = await get('/v1/policies/agent-1');
    const qpolicy = {
      ...policy.json,
      agentId: 'agent-1',
      quorumApprovals: 2,
      quorumAboveTransferQtyBaseUnits: '5000',
    };
    const putPolicy = await put('/v1/policies/agent-1', qpolicy);
    check('quorum policy applies', putPolicy.status === 200, putPolicy.json);
    const qheld = await post('/v1/assets/transfer', {
      agentId: 'agent-1', assetName: 'HOLDCOIN', qty: '6000', destination: 'munknown00000000000000000000000',
    });
    check('quorum transfer holds with quorumRequired 2', qheld.status === 202 &&
      qheld.json?.decision?.quorumRequired === 2, qheld.json);
    const qHoldId = qheld.json?.intent?.id as string;
    check('quorum hold_aging fires', await waitForHoldAging(2), holdAgingEvents().length);
    const qevent = holdAgingEvents().find((c) => c.body?.intentId === qHoldId)?.body;
    check('quorum hold_aging payload reports 0/2', qevent?.holdAging?.quorum?.approvalsReceived === 0 &&
      qevent?.holdAging?.quorum?.approvalsRequired === 2, qevent?.holdAging);
    // The reminder is the sendMessage for this hold whose text says
    // "Still waiting" — the first sendMessage with the id is the original
    // hold notification, not the reminder.
    const qReminder = tgSends().find((c) =>
      (c.body?.text as string | undefined)?.includes(qHoldId) &&
      (c.body?.text as string | undefined)?.includes('Still waiting'),
    );
    check('quorum reminder reports 0/2', (qReminder?.body?.text as string)?.includes('approvals: 0/2') === true,
      qReminder?.body?.text);
    const denied = await post(`/v1/intents/${qHoldId}/deny`, { approver: 'bob' });
    check('quorum hold denied to clean up', denied.status === 200 && denied.json?.denied === true, denied.json);
    await sleep(1200);
    check('no hold_aging event after deny', holdAgingEvents().length === 2, holdAgingEvents().length);
  } finally {
    api?.kill();
    await new Promise<void>((resolve) => webhookStub.close(() => resolve()));
    await new Promise<void>((resolve) => tgStub.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  await unitChecks();
  await integrationChecks();
  console.log(failures === 0 ? 'hold-aging-test: all green' : `hold-aging-test: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
