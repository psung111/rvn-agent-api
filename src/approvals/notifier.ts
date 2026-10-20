/**
 * Approval notifications: route REQUIRE_APPROVAL intents to the owner's
 * messaging channel. The bot token and chat id come from the environment
 * (TELEGRAM_APPROVAL_BOT_TOKEN, TELEGRAM_APPROVAL_CHAT_ID); when either is
 * unset the notifier stays disabled and the intent simply waits for
 * POST /v1/intents/:id/approve. The token never appears in logs, audit
 * entries, or the message payload.
 *
 * Per-agent routing: TELEGRAM_APPROVAL_CHAT_IDS_JSON maps agentId -> chat id
 * so different agents' holds can land in different chats; everyone else goes
 * to TELEGRAM_APPROVAL_CHAT_ID.
 *
 * Every hold message carries Approve / Deny inline buttons. Button taps come
 * back through POST /v1/telegram/webhook as callback queries and resolve the
 * intent through the same path as the HTTP approve/deny routes.
 */
import type { Decision, RvnIntent } from '../policy/types.js';
import { buildInlineKeyboard } from './callbacks.js';
import { telegramApiBase } from './telegram-api.js';

export interface ApprovalNotifier {
  /** Transport name for logs/audit (e.g. 'telegram'). */
  name: string;
  /** False when the transport has no credentials configured. */
  enabled: boolean;
  /** Notify the owner that `intent` is held for approval. */
  notify(intent: RvnIntent, decision: Decision): Promise<void>;
}

export interface TelegramConfig {
  botToken: string;
  /** Default chat when an agent has no dedicated route. */
  defaultChatId: string;
  /** Per-agent overrides: agentId -> chat id. */
  chatIdsByAgent: Record<string, string>;
}

function parseChatRoutes(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v) out[k] = v;
      }
      return out;
    }
  } catch {
    // Malformed JSON is a config error, but it must not take down startup —
    // fall back to the default chat and let the log line say so.
  }
  return {};
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_APPROVAL_BOT_TOKEN;
  const defaultChatId = env.TELEGRAM_APPROVAL_CHAT_ID;
  if (!botToken || !defaultChatId) return null;
  return {
    botToken,
    defaultChatId,
    chatIdsByAgent: parseChatRoutes(env.TELEGRAM_APPROVAL_CHAT_IDS_JSON),
  };
}

/** Route a hold notification to the agent's dedicated chat, or the default. */
export function chatIdFor(config: TelegramConfig, agentId: string): string {
  return config.chatIdsByAgent[agentId] ?? config.defaultChatId;
}

function opLabel(intent: RvnIntent): string {
  return intent.kind === 'issue_asset' ? 'ISSUE' : 'TRANSFER';
}

/**
 * Human-readable hold message. Contains only public intent facts — no token,
 * no chat id, no policy internals beyond the decision's reason codes.
 */
export function formatApprovalMessage(intent: RvnIntent, decision: Decision): string {
  const expires = new Date(decision.expiresAtMs).toISOString();
  const lines = [
    `🛑 Approval needed — RVN agent intent`,
    ``,
    `op:        ${opLabel(intent)}`,
    `intent:    ${intent.id}`,
    `agent:     ${intent.agentId}`,
    `asset:     ${intent.assetName}`,
    `qty:       ${intent.qtyBaseUnits} base units`,
    `dest:      ${intent.destination}`,
    `reasons:   ${decision.reasonCodes.join(', ')}`,
    `expires:   ${expires}`,
    ``,
    `To approve (replace <API> with your host):`,
    `curl -X POST <API>/v1/intents/${intent.id}/approve \\`,
    `  -H 'content-type: application/json' -d '{"approver":"you"}'`,
  ];
  return lines.join('\n');
}

const MAX_MESSAGE_LEN = 4096;

/**
 * Low-level sender, injectable so tests can assert on the outgoing payload
 * without touching Telegram. `sender(url, body)` behaves like a fetch POST.
 */
export type TelegramSender = (url: string, body: unknown) => Promise<{ ok: boolean; status: number }>;

export const defaultSender: TelegramSender = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
};

export class TelegramApprovalNotifier implements ApprovalNotifier {
  readonly name = 'telegram';
  readonly enabled = true;
  private readonly url: string;
  private readonly config: TelegramConfig;

  constructor(
    config: TelegramConfig,
    private readonly sender: TelegramSender = defaultSender,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = config;
    // The token lives only in the request URL, built here and never logged.
    // The base is overridable so tests can point at a local stub.
    this.url = `${telegramApiBase(env)}/bot${config.botToken}/sendMessage`;
  }

  async notify(intent: RvnIntent, decision: Decision): Promise<void> {
    const text = formatApprovalMessage(intent, decision).slice(0, MAX_MESSAGE_LEN);
    const body = {
      chat_id: chatIdFor(this.config, intent.agentId),
      text,
      disable_notification: false,
      reply_markup: buildInlineKeyboard(intent.id),
    };
    // One retry after a brief backoff; two attempts total, then throw.
    for (let attempt = 1; ; attempt++) {
      const { ok, status } = await this.sender(this.url, body);
      if (ok) return;
      if (attempt >= 2) {
        throw new Error(`telegram sendMessage failed after ${attempt} attempts (status ${status})`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export class NoopNotifier implements ApprovalNotifier {
  readonly name = 'noop';
  readonly enabled = false;
  async notify(_intent: RvnIntent, _decision: Decision): Promise<void> {
    // Intentionally silent: nothing configured, the intent waits for HTTP approval.
  }
}

/** Build the active notifier from the environment; Noop when unconfigured. */
export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalNotifier {
  const config = telegramConfigFromEnv(env);
  return config ? new TelegramApprovalNotifier(config) : new NoopNotifier();
}
