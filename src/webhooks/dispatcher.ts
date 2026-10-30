/**
 * Outbound webhooks: POST decision/execution events to a configured URL so
 * an operator's own service (a dashboard, a SIEM, a Discord relay) can react
 * to what the policy engine does without polling /v1/audit.
 *
 * Slice 1 is deliberately small: one URL, four event types, HMAC signing.
 * Config comes from the environment:
 *
 *   RVN_WEBHOOK_URL    — the POST target; unset (or not http/https) means
 *                        webhooks are disabled and the API behaves exactly
 *                        as before.
 *   RVN_WEBHOOK_SECRET — optional shared secret. When set, every delivery
 *                        carries an `X-Rvn-Signature: sha256=<hex>` header
 *                        (HMAC-SHA256 over the raw JSON body) so the
 *                        receiver can prove the event came from this API.
 *                        The secret never appears in logs, audit entries,
 *                        or payloads.
 *
 * Delivery failures never fail the request that produced the event — the
 * dispatcher throws after its retries and the server audits that as
 * WEBHOOK_DELIVERY_FAILED, exactly like approval-notification failures.
 * The payload carries only public intent facts: no secrets, no policy
 * internals beyond the decision's reason codes.
 */
import { createHmac } from 'node:crypto';
import type { Decision, RvnIntent } from '../policy/types.js';

export type WebhookEvent =
  | 'intent.decided'
  | 'intent.executed'
  | 'intent.denied'
  | 'intent.execution_failed';

export interface WebhookPayload {
  event: WebhookEvent;
  version: 1;
  atMs: number;
  intentId: string;
  agentId: string;
  intent: {
    kind: RvnIntent['kind'];
    assetName: string;
    qtyBaseUnits: string;
    destination: string;
  };
  /** Present on decided events (and denied events, as the final decision). */
  decision?: { kind: Decision['kind']; reasonCodes: string[] };
  /** Present on executed events. */
  txid?: string;
  /** Present on execution-failed events. */
  error?: string;
}

export function buildWebhookPayload(
  event: WebhookEvent,
  intent: RvnIntent,
  extra: { decision?: Decision; txid?: string; error?: string } = {},
  atMs: number = Date.now(),
): WebhookPayload {
  return {
    event,
    version: 1,
    atMs,
    intentId: intent.id,
    agentId: intent.agentId,
    intent: {
      kind: intent.kind,
      assetName: intent.assetName,
      qtyBaseUnits: intent.qtyBaseUnits,
      destination: intent.destination,
    },
    ...(extra.decision
      ? { decision: { kind: extra.decision.kind, reasonCodes: extra.decision.reasonCodes } }
      : {}),
    ...(extra.txid !== undefined ? { txid: extra.txid } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

/** HMAC-SHA256 over the raw body, in the `sha256=<hex>` form receivers check. */
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
}

/**
 * Parse webhook config from the environment. A missing URL disables
 * webhooks; a malformed or non-http(s) URL also disables them (loudly, via
 * the caller's log) rather than crashing startup — same degraded-gracefully
 * stance as the Telegram config parser.
 */
export function webhookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig | null {
  const url = env.RVN_WEBHOOK_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const secret = env.RVN_WEBHOOK_SECRET;
  return { url, ...(secret ? { secret } : {}) };
}

/**
 * Low-level sender, injectable so tests can assert on the outgoing payload
 * without touching the network. `sender(url, body, headers)` behaves like a
 * fetch POST and reports ok/status.
 */
export type WebhookSender = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ ok: boolean; status: number }>;

export const defaultSender: WebhookSender = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', headers, body });
  return { ok: res.ok, status: res.status };
};

export class WebhookDispatcher {
  readonly name = 'webhook';
  readonly enabled: boolean;
  private readonly config: WebhookConfig | null;

  constructor(
    config: WebhookConfig | null,
    private readonly sender: WebhookSender = defaultSender,
  ) {
    this.config = config;
    this.enabled = config !== null;
  }

  /** Deliver one event. No-op when unconfigured; throws after retries on failure. */
  async deliver(
    event: WebhookEvent,
    intent: RvnIntent,
    extra: { decision?: Decision; txid?: string; error?: string } = {},
  ): Promise<void> {
    if (!this.config) return;
    const body = JSON.stringify(buildWebhookPayload(event, intent, extra));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-rvn-event': event,
      ...(this.config.secret ? { 'x-rvn-signature': signPayload(this.config.secret, body) } : {}),
    };
    // One retry after a brief backoff; two attempts total, then throw —
    // the caller audits the failure and never fails the original request.
    for (let attempt = 1; ; attempt++) {
      const { ok, status } = await this.sender(this.config.url, body, headers);
      if (ok) return;
      if (attempt >= 2) {
        throw new Error(`webhook delivery failed after ${attempt} attempts (status ${status})`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Build the active dispatcher from the environment; disabled when unconfigured. */
export function webhookDispatcherFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookDispatcher {
  return new WebhookDispatcher(webhookConfigFromEnv(env));
}
