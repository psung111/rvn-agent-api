/**
 * Outbound webhooks: POST decision/execution events to configured URLs so
 * an operator's own services (a dashboard, a SIEM, a Discord relay) can
 * react to what the policy engine does without polling /v1/audit.
 *
 * Slice 1: one URL, four event types, HMAC signing.
 * Slice 2: multiple endpoints with per-event subscriptions. Config comes
 * from the environment:
 *
 *   RVN_WEBHOOK_URL    — the legacy single POST target; unset (or not
 *                        http/https) means no legacy endpoint. Still
 *                        supported alongside RVN_WEBHOOKS_JSON.
 *   RVN_WEBHOOK_SECRET — optional shared secret for the legacy endpoint.
 *   RVN_WEBHOOKS_JSON  — JSON array of endpoints, each
 *                        { url, secret?, events? } where `events` is a
 *                        subset of the four event types; an omitted
 *                        `events` means "all events". Malformed JSON,
 *                        malformed entries, non-http(s) URLs, and entries
 *                        whose events filter down to nothing are skipped
 *                        (degraded gracefully, never a startup crash) —
 *                        the same stance as the Telegram config parser.
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
  /** Subscribed event types; undefined (or absent) means all events. */
  events?: WebhookEvent[];
}

const ALL_EVENTS: WebhookEvent[] = [
  'intent.decided',
  'intent.executed',
  'intent.denied',
  'intent.execution_failed',
];

function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && (ALL_EVENTS as string[]).includes(value);
}

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse one endpoint entry; returns null for anything unusable. */
function parseEndpointEntry(entry: unknown): WebhookConfig | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { url, secret, events } = entry as Record<string, unknown>;
  if (!isHttpUrl(url)) return null;
  const config: WebhookConfig = { url };
  if (typeof secret === 'string' && secret) config.secret = secret;
  if (events !== undefined) {
    if (!Array.isArray(events)) return null;
    const filtered = events.filter(isWebhookEvent);
    if (filtered.length === 0) return null;
    config.events = filtered;
  }
  return config;
}

/**
 * Parse all webhook endpoints from the environment: the RVN_WEBHOOKS_JSON
 * list first, then the legacy single RVN_WEBHOOK_URL endpoint. Returns []
 * when nothing usable is configured. Never throws.
 */
export function webhookConfigsFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig[] {
  const configs: WebhookConfig[] = [];
  const raw = env.RVN_WEBHOOKS_JSON;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const config = parseEndpointEntry(entry);
          if (config) configs.push(config);
        }
      }
    } catch {
      // Malformed JSON degrades to "no list endpoints", same as slice 1.
    }
  }
  const legacy = webhookConfigFromEnv(env);
  if (legacy) configs.push(legacy);
  return configs;
}

/**
 * Parse the legacy single-endpoint webhook config from the environment.
 * A missing URL disables it; a malformed or non-http(s) URL also disables
 * it (loudly, via the caller's log) rather than crashing startup — same
 * degraded-gracefully stance as the Telegram config parser.
 */
export function webhookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig | null {
  const url = env.RVN_WEBHOOK_URL;
  if (!isHttpUrl(url)) return null;
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
  private readonly configs: WebhookConfig[];

  constructor(
    config: WebhookConfig | WebhookConfig[] | null,
    private readonly sender: WebhookSender = defaultSender,
  ) {
    this.configs = config === null ? [] : Array.isArray(config) ? config : [config];
    this.enabled = this.configs.length > 0;
  }

  /** Number of configured endpoints (0 when disabled). */
  get endpointCount(): number {
    return this.configs.length;
  }

  /** Endpoints subscribed to this event (all events when `events` is absent). */
  endpointsFor(event: WebhookEvent): WebhookConfig[] {
    return this.configs.filter((c) => !c.events || c.events.includes(event));
  }

  /**
   * Deliver one event to every subscribed endpoint. Returns the number of
   * endpoints attempted (0 when no endpoint subscribes to the event).
   * A failure at one endpoint never blocks the others; after all attempts,
   * throws listing the failed endpoints (URLs only, never secrets) so the
   * caller can audit the failure. No-op when unconfigured.
   */
  async deliver(
    event: WebhookEvent,
    intent: RvnIntent,
    extra: { decision?: Decision; txid?: string; error?: string } = {},
  ): Promise<number> {
    const targets = this.endpointsFor(event);
    if (targets.length === 0) return 0;
    const body = JSON.stringify(buildWebhookPayload(event, intent, extra));
    const failed: string[] = [];
    for (const config of targets) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-rvn-event': event,
        ...(config.secret ? { 'x-rvn-signature': signPayload(config.secret, body) } : {}),
      };
      // One retry after a brief backoff; two attempts total, then give up
      // on this endpoint — the caller audits the failure and never fails
      // the original request.
      let delivered = false;
      for (let attempt = 1; ; attempt++) {
        const { ok, status } = await this.sender(config.url, body, headers);
        if (ok) {
          delivered = true;
          break;
        }
        if (attempt >= 2) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!delivered) failed.push(config.url);
    }
    if (failed.length > 0) {
      throw new Error(`webhook delivery failed for ${failed.length} endpoint(s): ${failed.join(', ')}`);
    }
    return targets.length;
  }
}

/** Build the active dispatcher from the environment; disabled when unconfigured. */
export function webhookDispatcherFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookDispatcher {
  return new WebhookDispatcher(webhookConfigsFromEnv(env));
}
