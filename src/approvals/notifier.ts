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
import { formatAgeMs, quorumProgressOf } from './hold-aging.js';
import { telegramApiBase } from './telegram-api.js';

export interface ApprovalNotifier {
  /** Transport name for logs/audit (e.g. 'telegram'). */
  name: string;
  /** False when the transport has no credentials configured. */
  enabled: boolean;
  /** Notify the owner that `intent` is held for approval. */
  notify(intent: RvnIntent, decision: Decision): Promise<void>;
  /**
   * Re-notify the owner that `intent` is still held (v0.34.0): the
   * hold-aging reminder, sent once per hold after it has sat
   * unapproved past the configured threshold. Same buttons as the
   * original hold message, so the approver can act from the reminder.
   */
  notifyAging(intent: RvnIntent, decision: Decision, ageMs: number): Promise<void>;
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
  if (intent.kind === 'issue_asset') return 'ISSUE';
  if (intent.kind === 'reissue_asset') return 'REISSUE';
  if (intent.kind === 'issue_subasset') return 'SUBASSET';
  if (intent.kind === 'issue_unique') return 'UNIQUE';
  return 'TRANSFER';
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

/**
 * Human-readable hold-aging reminder (v0.34.0). Same public facts as the
 * hold message, plus how long the hold has sat and the quorum progress
 * (n/N of M) when a quorum is in force — so the approver can see at a
 * glance whether the hold is waiting on them or on someone else.
 */
export function formatHoldAgingMessage(intent: RvnIntent, decision: Decision, ageMs: number): string {
  const waitingSince = new Date(decision.decidedAtMs).toISOString();
  const quorum = quorumProgressOf(decision);
  const lines = [
    `⏰ Still waiting — RVN agent intent held ${formatAgeMs(ageMs)}`,
    ``,
    `op:        ${opLabel(intent)}`,
    `intent:    ${intent.id}`,
    `agent:     ${intent.agentId}`,
    `asset:     ${intent.assetName}`,
    `qty:       ${intent.qtyBaseUnits} base units`,
    `dest:      ${intent.destination}`,
    `reasons:   ${decision.reasonCodes.join(', ')}`,
    ...(quorum
      ? [
          `approvals: ${quorum.approvalsReceived}/${quorum.approvalsRequired}${quorum.approversTotal !== undefined ? ` of ${quorum.approversTotal}` : ''}`,
        ]
      : []),
    `waiting since: ${waitingSince}`,
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

  async notifyAging(intent: RvnIntent, decision: Decision, ageMs: number): Promise<void> {
    // Same send path as the hold message (one retry, then throw), with
    // the aging text instead — the approver can act from the reminder.
    const text = formatHoldAgingMessage(intent, decision, ageMs).slice(0, MAX_MESSAGE_LEN);
    const body = {
      chat_id: chatIdFor(this.config, intent.agentId),
      text,
      disable_notification: false,
      reply_markup: buildInlineKeyboard(intent.id),
    };
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
  async notifyAging(_intent: RvnIntent, _decision: Decision, _ageMs: number): Promise<void> {
    // Intentionally silent: nothing configured, no reminder to send.
  }
}

/** Build the active notifier from the environment; Noop when unconfigured. */
export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalNotifier {
  const config = telegramConfigFromEnv(env);
  return config ? new TelegramApprovalNotifier(config) : new NoopNotifier();
}
