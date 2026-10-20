/**
 * telegram-callback-test: checks for slice 2 of the Telegram approvals item.
 *
 *  pnpm test:telegram-callback
 *
 * Unit: callback-data round-trip, keyboard shape, resolved-message format.
 * Integration: boots the real API as a child process with a local stub
 * standing in for api.telegram.org (via TELEGRAM_API_BASE_URL), then drives
 * POST /v1/telegram/webhook through the deny and approve callback flows.
 * Nothing touches the network: the stub and the API are both localhost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  buildCallbackData,
  buildInlineKeyboard,
  formatResolvedMessage,
  parseCallbackData,
} from '../src/approvals/callbacks.js';
import {
  chatIdFor,
  telegramConfigFromEnv,
  type TelegramConfig,
} from '../src/approvals/notifier.js';
import type { Decision, RvnIntent } from '../src/policy/types.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3121;
const STUB_PORT = 3122;
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
  id: 'intent-abc123',
  agentId: 'agent-1',
  kind: 'transfer_asset',
  assetName: 'DEMOCOIN',
  qtyBaseUnits: '100',
  destination: 'mtest1stranger000001xxxxxxxxxxxx',
  requestedAtMs: Date.now(),
};
const decision: Decision = {
  intentId: intent.id,
  agentId: intent.agentId,
  kind: 'REQUIRE_APPROVAL',
  reasonCodes: ['UNKNOWN_DESTINATION'],
  decidedAtMs: Date.now(),
  expiresAtMs: Date.now() + 3600_000,
};

// ---- local stub for the Telegram Bot API ----
const stubCalls: Array<{ method: string; body: any }> = [];
let stub: Server;

async function startStub(): Promise<void> {
  stub = createServer((req, res) => {
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
      stubCalls.push({ method: m?.[1] ?? url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
}

// ---- helpers for driving the API ----
let child: ChildProcess | null = null;

async function startApi(): Promise<void> {
  child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MOCK_RVN: 'true',
      TELEGRAM_APPROVAL_BOT_TOKEN: 'fake-token-for-tests',
      TELEGRAM_APPROVAL_CHAT_ID: '111',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain so a noisy child never blocks on a full pipe.
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  // Wait for /v1/health.
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

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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
  const res = await fetch(`${API}${path}`);
  return (await res.json()) as any;
}

function stubCallsTo(method: string) {
  return stubCalls.filter((c) => c.method === method);
}

function callbackUpdate(
  queryId: string,
  data: string,
  messageId: number,
): Record<string, unknown> {
  return {
    update_id: 1,
    callback_query: {
      id: queryId,
      from: { id: 85247355, first_name: 'Paul' },
      message: { message_id: messageId, chat: { id: 111 } },
      data,
    },
  };
}

const secretHeader = { 'x-telegram-bot-api-secret-token': SECRET };

async function main() {
  // ===== unit: callbacks module =====
  check(
    'callback data round-trips (approve)',
    parseCallbackData(buildCallbackData('approve', 'intent-abc123'))?.action === 'approve',
  );
  check(
    'callback data round-trips (deny)',
    (() => {
      const p = parseCallbackData(buildCallbackData('deny', 'intent-abc123'));
      return p?.action === 'deny' && p?.intentId === 'intent-abc123';
    })(),
  );
  for (const bad of ['approve', 'approve:', ':intent-abc123', 'selfdestruct:x', 'approve:../x', 'approve:a b', '']) {
    check(`parseCallbackData rejects ${JSON.stringify(bad)}`, parseCallbackData(bad) === null);
  }

  const kb = buildInlineKeyboard('intent-abc123');
  check(
    'keyboard has Approve/Deny buttons with callback data',
    kb.inline_keyboard.length === 1 &&
      kb.inline_keyboard[0][0].callback_data === 'approve:intent-abc123' &&
      kb.inline_keyboard[0][1].callback_data === 'deny:intent-abc123',
  );

  const approvedMsg = formatResolvedMessage(intent, decision, 'approve', 'telegram:Paul', 'txid-1');
  check('approved message names the approver and txid', approvedMsg.includes('telegram:Paul') && approvedMsg.includes('txid-1'));
  const deniedMsg = formatResolvedMessage(intent, decision, 'deny', 'telegram:Paul');
  check('denied message names the denier, no txid', deniedMsg.includes('Denied by telegram:Paul') && !deniedMsg.includes('txid'));

  // ===== unit: per-agent chat routing =====
  const cfg: TelegramConfig = { botToken: 'fake', defaultChatId: '111', chatIdsByAgent: { 'agent-1': '999' } };
  check('routed agent gets its own chat', chatIdFor(cfg, 'agent-1') === '999');
  check('unrouted agent falls back to default', chatIdFor(cfg, 'agent-9') === '111');
  const fromEnv = telegramConfigFromEnv({
    TELEGRAM_APPROVAL_BOT_TOKEN: 't',
    TELEGRAM_APPROVAL_CHAT_ID: '111',
    TELEGRAM_APPROVAL_CHAT_IDS_JSON: '{"agent-1":"999"}',
  });
  check('env JSON map parses', fromEnv?.chatIdsByAgent['agent-1'] === '999' && fromEnv?.defaultChatId === '111');
  check(
    'malformed JSON map falls back to empty, not a crash',
    telegramConfigFromEnv({
      TELEGRAM_APPROVAL_BOT_TOKEN: 't',
      TELEGRAM_APPROVAL_CHAT_ID: '111',
      TELEGRAM_APPROVAL_CHAT_IDS_JSON: 'not-json',
    })?.defaultChatId === '111',
  );

  // ===== integration: the real API behind a stub Telegram =====
  await startStub();
  await startApi();

  const health = await get('/v1/health');
  check('health: telegram configured', health.approvals?.telegramConfigured === true);
  check('health: webhook secret configured', health.approvals?.telegramWebhookSecretConfigured === true);
  check('health: zero per-agent routes', health.approvals?.perAgentChatRoutes === 0);

  const { address } = (await post('/v1/wallets', {})).json;
  // Allowlist the wallet so the setup issue lands ALLOW (default policy
  // requires approval for non-allowlisted destinations).
  const policy = await get('/v1/policies/agent-1');
  const putPolicy = await fetch(`${API}/v1/policies/agent-1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...policy, agentId: 'agent-1', allowedDestinations: [address] }),
  });
  check('policy allowlists the agent wallet', putPolicy.status === 200);
  const issue = await post('/v1/assets/issue', {
    agentId: 'agent-1', name: 'DEMOCOIN', qty: '1000', toAddress: address,
  });
  check('setup issue is ALLOW', issue.status === 200 && issue.json.decision?.kind === 'ALLOW', issue.json);

  // 1. hold a transfer -> outbound message with buttons
  const held = await post('/v1/assets/transfer', {
    agentId: 'agent-1', assetName: 'DEMOCOIN', qty: '100', destination: 'mtest1stranger000001xxxxxxxxxxxx',
  });
  const intentId1: string | undefined = held.json.intent?.id;
  check('transfer held for approval', held.status === 202 && !!intentId1, held.json);

  const sends = stubCallsTo('sendMessage');
  check('hold posted sendMessage to the stub', sends.length === 1, sends.length);
  const kbSent = sends[0]?.body?.reply_markup?.inline_keyboard?.[0] ?? [];
  check('chat routed to default chat id', sends[0]?.body?.chat_id === '111');
  check(
    'buttons carry approve/deny callback data for the intent',
    kbSent[0]?.callback_data === `approve:${intentId1}` && kbSent[1]?.callback_data === `deny:${intentId1}`,
    kbSent,
  );
  check('sendMessage payload has no token', JSON.stringify(sends[0]?.body).includes('fake-token') === false);

  // 2. secret enforcement
  const noSecret = await post('/v1/telegram/webhook', callbackUpdate('cq-x', `deny:${intentId1}`, 7));
  check('webhook rejects a missing secret (403)', noSecret.status === 403, noSecret.json);

  // 3. deny via button
  const deny = await post('/v1/telegram/webhook', callbackUpdate('cq-1', `deny:${intentId1}`, 7), secretHeader);
  check('deny callback answered 200', deny.status === 200 && deny.json?.ok === true, deny.json);
  const answers1 = stubCallsTo('answerCallbackQuery');
  check('callback acknowledged with a Denied toast', answers1.some((a) => String(a.body?.text).includes('Denied')), answers1.map((a) => a.body?.text));
  const edits1 = stubCallsTo('editMessageText');
  check(
    'hold message edited to show the denial',
    edits1.some((e) => e.body?.message_id === 7 && String(e.body?.text).includes('Denied by telegram:Paul')),
    edits1.map((e) => e.body?.text?.slice(0, 60)),
  );
  const pending1 = await get('/v1/intents/pending');
  check('denied intent leaves pending', !pending1.pending?.some((p: any) => p.intent.id === intentId1));
  const audit1 = await get('/v1/audit?limit=50');
  check(
    'audit has a DENIAL entry for the intent',
    audit1.chainValid === true && audit1.entries?.some((e: any) => e.kind === 'DENIAL' && e.intentId === intentId1),
  );

  // 4. approve via button on a fresh hold
  const held2 = await post('/v1/assets/transfer', {
    agentId: 'agent-1', assetName: 'DEMOCOIN', qty: '100', destination: 'mtest1stranger000001xxxxxxxxxxxx',
  });
  const intentId2: string | undefined = held2.json.intent?.id;
  check('second transfer held for approval', held2.status === 202 && !!intentId2, held2.json);

  const approve = await post('/v1/telegram/webhook', callbackUpdate('cq-2', `approve:${intentId2}`, 8), secretHeader);
  check('approve callback answered 200', approve.status === 200 && approve.json?.ok === true, approve.json);
  const answers2 = stubCallsTo('answerCallbackQuery');
  check('callback acknowledged with an Approved toast + txid', answers2.some((a) => String(a.body?.text).includes('Approved — txid')), answers2.map((a) => a.body?.text));
  const edits2 = stubCallsTo('editMessageText');
  check(
    'hold message edited to show the approval and txid',
    edits2.some((e) => e.body?.message_id === 8 && String(e.body?.text).includes('Approved by telegram:Paul')),
  );
  const audit2 = await get('/v1/audit?limit=50');
  check(
    'audit shows APPROVAL then EXECUTION_SKIPPED for the approved intent',
    audit2.entries?.some((e: any) => e.kind === 'APPROVAL' && e.intentId === intentId2) &&
      audit2.entries?.some((e: any) => e.kind === 'EXECUTION_SKIPPED' && e.intentId === intentId2),
  );

  // 5. repeat / malformed callbacks never make Telegram retry
  const again = await post('/v1/telegram/webhook', callbackUpdate('cq-3', `approve:${intentId2}`, 8), secretHeader);
  check('re-approve callback still answers 200', again.status === 200, again.json);
  const answers3 = stubCallsTo('answerCallbackQuery');
  check(
    're-approve toast reports the conflict, no re-execution',
    answers3.some((a) => String(a.body?.text).includes('not pending approval')),
    answers3.map((a) => a.body?.text),
  );
  const unknown = await post(
    '/v1/telegram/webhook',
    callbackUpdate('cq-4', 'approve:00000000-0000-0000-0000-000000000000', 9),
    secretHeader,
  );
  check('unknown-intent callback answers 200', unknown.status === 200, unknown.json);
  check(
    'unknown-intent toast says so',
    stubCallsTo('answerCallbackQuery').some((a) => String(a.body?.text).includes('unknown intent')),
  );
  const malformed = await post('/v1/telegram/webhook', callbackUpdate('cq-5', 'self-destruct', 9), secretHeader);
  check('malformed callback data answers 200 with guidance', malformed.status === 200, malformed.json);
  check(
    'malformed toast guides the owner',
    stubCallsTo('answerCallbackQuery').some((a) => String(a.body?.text).includes('Unknown action')),
  );
  const notCallback = await post('/v1/telegram/webhook', { update_id: 2 }, secretHeader);
  check('non-callback update is ignored, 200', notCallback.status === 200 && notCallback.json?.ignored === 'not a callback query');

  // 6. HTTP deny endpoint still works (the MCP deny_intent route)
  const held3 = await post('/v1/assets/transfer', {
    agentId: 'agent-1', assetName: 'DEMOCOIN', qty: '50', destination: 'mtest1stranger000001xxxxxxxxxxxx',
  });
  const intentId3: string | undefined = held3.json.intent?.id;
  const httpDeny = await post(`/v1/intents/${intentId3}/deny`, { approver: 'tester' });
  check('POST /v1/intents/:id/deny denies (200)', httpDeny.status === 200 && httpDeny.json?.denied === true, httpDeny.json);
  const approveAfterDeny = await post(`/v1/intents/${intentId3}/approve`, { approver: 'tester' });
  check('approving a denied intent is a 409', approveAfterDeny.status === 409, approveAfterDeny.json);

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all telegram-callback checks passed');
}

async function shutdown() {
  child?.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
}

main()
  .catch((e) => {
    console.error('FAIL: unexpected error', e);
    process.exitCode = 1;
  })
  .finally(() => shutdown());
