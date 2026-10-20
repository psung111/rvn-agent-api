/**
 * approval-notify-test: unit checks for src/approvals/notifier.ts.
 *
 *  pnpm test:approvals
 *
 * The Telegram sender is injected, so nothing touches the network. Asserts:
 *   - env parsing: missing vars -> disabled NoopNotifier
 *   - message format: carries intent id, approve endpoint, reasons, expiry
 *   - token hygiene: the bot token never appears in the message text
 *   - retry: one failed attempt is retried, then success; two failures throw
 */
import {
  formatApprovalMessage,
  notifierFromEnv,
  telegramConfigFromEnv,
  TelegramApprovalNotifier,
  NoopNotifier,
  type TelegramConfig,
  type TelegramSender,
} from '../src/approvals/notifier.js';
import type { Decision, RvnIntent } from '../src/policy/types.js';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (extra !== undefined) console.log('      ', extra);
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

const TOKEN = '123456:SECRET-TOKEN-VALUE';

async function main() {
  // 1. env parsing
  check('no env -> null config', telegramConfigFromEnv({}) === null);
  check(
    'no env -> NoopNotifier, disabled',
    (() => {
      const n = notifierFromEnv({});
      return n instanceof NoopNotifier && n.enabled === false;
    })(),
  );
  check(
    'full env -> TelegramApprovalNotifier, enabled',
    (() => {
      const n = notifierFromEnv({
        TELEGRAM_APPROVAL_BOT_TOKEN: TOKEN,
        TELEGRAM_APPROVAL_CHAT_ID: '85247355',
      });
      return n instanceof TelegramApprovalNotifier && n.enabled === true;
    })(),
  );

  // 2. message format + token hygiene
  const text = formatApprovalMessage(intent, decision);
  check('message has intent id', text.includes('intent-abc123'));
  check('message has approve endpoint', text.includes('/v1/intents/intent-abc123/approve'));
  check('message has op label', text.includes('TRANSFER'));
  check('message has reason', text.includes('UNKNOWN_DESTINATION'));
  check('message has expiry', text.includes('expires:'));
  check('message fits Telegram cap', text.length <= 4096);
  check('message never contains the token', !text.includes(TOKEN) && !text.includes('123456:'));

  // 3. happy-path send
  const calls: Array<{ url: string; body: any }> = [];
  const okSender: TelegramSender = async (url, body) => {
    calls.push({ url, body: body as any });
    return { ok: true, status: 200 };
  };
  const config: TelegramConfig = { botToken: TOKEN, defaultChatId: '85247355', chatIdsByAgent: {} };
  await new TelegramApprovalNotifier(config, okSender).notify(intent, decision);
  check('sender called once', calls.length === 1);
  check('chat_id in body', calls[0]?.body.chat_id === '85247355');
  check('url hits telegram sendMessage', calls[0]?.url.startsWith('https://api.telegram.org/bot') === true
    && calls[0]?.url.endsWith('/sendMessage'));
  check('url is the only place the token may appear', calls[0]?.url.includes(TOKEN) === true);
  check('body carries no token', JSON.stringify(calls[0]?.body).includes(TOKEN) === false);

  // 3b. inline buttons + per-agent routing
  const buttons = calls[0]?.body?.reply_markup?.inline_keyboard?.[0] ?? [];
  check(
    'Approve/Deny buttons carry callback data',
    buttons[0]?.callback_data === 'approve:intent-abc123' && buttons[1]?.callback_data === 'deny:intent-abc123',
    buttons,
  );
  check('callback data carries no token', JSON.stringify(buttons).includes(TOKEN) === false);
  const routed = new TelegramApprovalNotifier(
    { botToken: TOKEN, defaultChatId: '85247355', chatIdsByAgent: { 'agent-1': '999' } },
    okSender,
  );
  calls.length = 0;
  await routed.notify(intent, decision);
  check('routed agent notifies its own chat', calls[0]?.body.chat_id === '999');
  const other = { ...intent, agentId: 'agent-9' };
  await routed.notify(other, decision);
  check('unrouted agent falls back to default chat', calls[1]?.body.chat_id === '85247355');

  // 4. retry: fail once, succeed
  let attempts = 0;
  const flaky: TelegramSender = async () => (++attempts === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 });
  await new TelegramApprovalNotifier(config, flaky).notify(intent, decision);
  check('retries once after a 500 then succeeds', attempts === 2);

  // 5. give up: fail twice -> throw, exactly two attempts
  attempts = 0;
  const down: TelegramSender = async () => {
    attempts++;
    return { ok: false, status: 429 };
  };
  let threw = false;
  try {
    await new TelegramApprovalNotifier(config, down).notify(intent, decision);
  } catch (e) {
    threw = e instanceof Error && e.message.includes('failed after 2 attempts');
  }
  check('throws after two failures', threw && attempts === 2);

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all approval-notify checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
