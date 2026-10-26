/**
 * Telegram inline-callback plumbing for slice 2 of the approval item.
 *
 * Outbound: every hold notification carries an inline keyboard with Approve /
 * Deny buttons whose callback_data is `approve:<intentId>` / `deny:<intentId>`.
 * Inbound: POST /v1/telegram/webhook parses the update and maps it to an
 * approve/deny resolution of the same intent — the same resolution path the
 * HTTP /v1/intents/:id/approve and /deny routes use.
 *
 * Pure functions — no network, no env — so they are unit-testable.
 */
import type { Decision, RvnIntent } from '../policy/types.js';

export type CallbackAction = 'approve' | 'deny';

export interface ParsedCallback {
  action: CallbackAction;
  intentId: string;
}

/** Encode a button action the way the webhook expects it back. */
export function buildCallbackData(action: CallbackAction, intentId: string): string {
  return `${action}:${intentId}`;
}

/**
 * Reverse of buildCallbackData. Returns null for anything we did not send —
 * unknown actions, missing ids, or anything that does not look like an
 * intent id we issued (intent ids are UUIDs, but we accept hex/dash strings
 * up to 64 chars so hand-made test ids work too).
 */
export function parseCallbackData(data: string): ParsedCallback | null {
  if (typeof data !== 'string') return null;
  const m = /^(approve|deny):([0-9a-zA-Z-]{1,64})$/.exec(data);
  if (!m) return null;
  return { action: m[1] as CallbackAction, intentId: m[2] };
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

/** Approve / Deny buttons attached to every hold notification. */
export function buildInlineKeyboard(intentId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: buildCallbackData('approve', intentId) },
        { text: '❌ Deny', callback_data: buildCallbackData('deny', intentId) },
      ],
    ],
  };
}

/**
 * Human-readable summary of the outcome, used to edit the hold message in
 * place so the chat history shows the final state. Contains only public
 * intent facts — no token, no policy internals.
 */
export function formatResolvedMessage(
  intent: RvnIntent,
  _decision: Decision,
  action: CallbackAction,
  approver: string,
  txid?: string,
): string {
  const op = intent.kind === 'issue_asset' ? 'ISSUE' : intent.kind === 'reissue_asset' ? 'REISSUE' : intent.kind === 'issue_unique' ? 'UNIQUE' : 'TRANSFER';
  const headline =
    action === 'approve' ? `✅ Intent approved — RVN agent intent` : `❌ Intent denied — RVN agent intent`;
  const verdict =
    action === 'approve'
      ? `✅ Approved by ${approver}${txid ? `\ntxid:    ${txid}` : ''}`
      : `❌ Denied by ${approver} — nothing executed`;
  return [
    headline,
    ``,
    `op:        ${op}`,
    `intent:    ${intent.id}`,
    `agent:     ${intent.agentId}`,
    `asset:     ${intent.assetName}`,
    `qty:       ${intent.qtyBaseUnits} base units`,
    `dest:      ${intent.destination}`,
    ``,
    verdict,
  ].join('\n');
}
