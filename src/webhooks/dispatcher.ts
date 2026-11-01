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
 * Slice 3: configurable retry/backoff. Global defaults come from the
 * environment (RVN_WEBHOOK_MAX_ATTEMPTS, RVN_WEBHOOK_RETRY_DELAY_MS,
 * RVN_WEBHOOK_RETRY_BACKOFF_FACTOR, RVN_WEBHOOK_RETRY_MAX_DELAY_MS);
 * a RVN_WEBHOOKS_JSON entry may override any of them per endpoint
 * (maxAttempts, retryDelayMs, backoffFactor, maxDelayMs). Invalid values
 * fall back to the default for that field, never a startup crash. The
 * delay before retry N (1-based, after the Nth failed attempt) is
 * min(baseDelayMs * backoffFactor^(N-1), maxDelayMs). maxAttempts counts
 * total attempts, so the historical default of 2 means one retry.
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

/** Retry/backoff for one endpoint. maxAttempts counts total attempts. */
export interface WebhookRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
}

export const DEFAULT_WEBHOOK_RETRY: WebhookRetryOptions = {
  maxAttempts: 2,
  baseDelayMs: 500,
  backoffFactor: 2,
  maxDelayMs: 30000,
};

/** Delay before retry N (1-based: after the Nth failed attempt), capped. */
export function retryDelayMs(options: WebhookRetryOptions, failedAttempt: number): number {
  return Math.min(
    options.baseDelayMs * Math.pow(options.backoffFactor, Math.max(0, failedAttempt - 1)),
    options.maxDelayMs,
  );
}

function parseIntInRange(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeInt(value: unknown, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) return fallback;
  return n;
}

/** Global retry defaults from the environment; invalid values fall back. */
export function webhookRetryFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookRetryOptions {
  return {
    maxAttempts: parseIntInRange(env.RVN_WEBHOOK_MAX_ATTEMPTS, 1, 10, DEFAULT_WEBHOOK_RETRY.maxAttempts),
    baseDelayMs: parseNonNegativeInt(env.RVN_WEBHOOK_RETRY_DELAY_MS, 60000, DEFAULT_WEBHOOK_RETRY.baseDelayMs),
    backoffFactor: parsePositiveNumber(env.RVN_WEBHOOK_RETRY_BACKOFF_FACTOR, DEFAULT_WEBHOOK_RETRY.backoffFactor),
    maxDelayMs: parseNonNegativeInt(env.RVN_WEBHOOK_RETRY_MAX_DELAY_MS, 600000, DEFAULT_WEBHOOK_RETRY.maxDelayMs),
  };
}

/** Per-endpoint retry overrides from a JSON entry; only valid fields kept. */
function parseEndpointRetry(entry: Record<string, unknown>): Partial<WebhookRetryOptions> {
  const retry: Partial<WebhookRetryOptions> = {};
  if (entry.maxAttempts !== undefined) {
    const n = parseIntInRange(entry.maxAttempts, 1, 10, -1);
    if (n !== -1) retry.maxAttempts = n;
  }
  if (entry.retryDelayMs !== undefined) {
    const n = parseNonNegativeInt(entry.retryDelayMs, 60000, -1);
    if (n !== -1) retry.baseDelayMs = n;
  }
  if (entry.backoffFactor !== undefined) {
    const n = parsePositiveNumber(entry.backoffFactor, -1);
    if (n !== -1) retry.backoffFactor = n;
  }
  if (entry.maxDelayMs !== undefined) {
    const n = parseNonNegativeInt(entry.maxDelayMs, 600000, -1);
    if (n !== -1) retry.maxDelayMs = n;
  }
  return retry;
}

export function resolveWebhookRetry(
  global: WebhookRetryOptions,
  override: Partial<WebhookRetryOptions> | undefined,
): WebhookRetryOptions {
  return { ...global, ...override };
}

export interface WebhookConfig {
  url: string;
  secret?: string;
  /** Subscribed event types; undefined (or absent) means all events. */
  events?: WebhookEvent[];
  /** Per-endpoint retry overrides; absent means the global defaults. */
  retry?: Partial<WebhookRetryOptions>;
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
  const retry = parseEndpointRetry(entry as Record<string, unknown>);
  if (Object.keys(retry).length > 0) config.retry = retry;
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

export interface WebhookDispatcherOptions {
  /** Global retry defaults; per-endpoint overrides in WebhookConfig win. */
  retry?: WebhookRetryOptions;
  /** Injectable sleep so tests can record delays without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export class WebhookDispatcher {
  readonly name = 'webhook';
  readonly enabled: boolean;
  private readonly configs: WebhookConfig[];
  private readonly retry: WebhookRetryOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: WebhookConfig | WebhookConfig[] | null,
    private readonly sender: WebhookSender = defaultSender,
    options: WebhookDispatcherOptions = {},
  ) {
    this.configs = config === null ? [] : Array.isArray(config) ? config : [config];
    this.enabled = this.configs.length > 0;
    this.retry = options.retry ?? DEFAULT_WEBHOOK_RETRY;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The effective global retry options (per-endpoint overrides excluded). */
  get retryOptions(): WebhookRetryOptions {
    return this.retry;
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
      // Retries with exponential backoff per the effective retry options;
      // then give up on this endpoint — the caller audits the failure and
      // never fails the original request.
      const retry = resolveWebhookRetry(this.retry, config.retry);
      let delivered = false;
      for (let attempt = 1; ; attempt++) {
        const { ok, status } = await this.sender(config.url, body, headers);
        if (ok) {
          delivered = true;
          break;
        }
        if (attempt >= retry.maxAttempts) break;
        await this.sleep(retryDelayMs(retry, attempt));
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
  return new WebhookDispatcher(webhookConfigsFromEnv(env), defaultSender, {
    retry: webhookRetryFromEnv(env),
  });
}
