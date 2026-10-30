import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import 'dotenv/config';
import {
  applyPreset,
  createsSupply,
  defaultPolicy,
  evaluateIntent,
  isExpired,
  POLICY_PRESETS,
  type Decision,
  type RvnIntent,
  type RvnPolicy,
} from './policy/index.js';
import { storeFromEnv, type Store } from './store/index.js';
import { notifierFromEnv, telegramConfigFromEnv } from './approvals/notifier.js';
import { webhookDispatcherFromEnv, type WebhookEvent } from './webhooks/dispatcher.js';
import { parseCallbackData, formatResolvedMessage, type CallbackAction } from './approvals/callbacks.js';
import { TelegramApi } from './approvals/telegram-api.js';
import { MockRvnNode } from './rvn/mock.js';
import { RvnRpcClient } from './rvn/client.js';
import type { RvnNode } from './rvn/types.js';

const MOCK = process.env.MOCK_RVN !== 'false';
const PORT = Number(process.env.PORT ?? 3001);

// Durable state behind the store seam: Postgres when RVN_DATABASE_URL is set
// and reachable, in-memory otherwise (see src/store/index.ts).
let store: Store;
const approvalNotifier = notifierFromEnv();
const webhookDispatcher = webhookDispatcherFromEnv();
const telegramConfig = telegramConfigFromEnv();
const telegramApi = telegramConfig ? new TelegramApi(telegramConfig.botToken) : null;
// Optional shared secret proving the update came from Telegram. Set it with
// BotFather's /setwebhook secret_token parameter; when unset any caller may
// hit the webhook (fine for local dev, not for a public host).
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// Shape of the Telegram Bot API update we care about.
interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { first_name?: string; username?: string };
  message?: { message_id: number; chat: { id: number | string } };
}
interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
}

function getNode(): RvnNode {
  if (MOCK) return new MockRvnNode();
  const { RVN_RPC_URL, RVN_RPC_USER, RVN_RPC_PASS } = process.env;
  if (!RVN_RPC_URL || !RVN_RPC_USER || !RVN_RPC_PASS) {
    throw new Error('live mode needs RVN_RPC_URL, RVN_RPC_USER and RVN_RPC_PASS');
  }
  return new RvnRpcClient({ url: RVN_RPC_URL, user: RVN_RPC_USER, pass: RVN_RPC_PASS });
}

// One node per process lifetime (mock keeps state; real client is stateless).
const node = getNode();

async function main() {
  const app = Fastify({ logger: true });
  store = await storeFromEnv((msg) => app.log.warn(msg));
  const shutdown = () => {
    store
      .close()
      .catch((err) => app.log.error({ err }, 'store close failed'))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (MOCK) app.log.warn('MOCK_RVN=true — in-memory mock node, nothing touches chain');
  app.log.info(
    approvalNotifier.enabled
      ? `approval notifications: ${approvalNotifier.name}`
      : 'approval notifications: none configured (held intents wait for POST /v1/intents/:id/approve)',
  );
  app.log.info(
    WEBHOOK_SECRET
      ? 'telegram webhook: secret check enabled'
      : 'telegram webhook: no secret configured (set TELEGRAM_WEBHOOK_SECRET for a public host)',
  );

  const policyFor = async (agentId: string): Promise<RvnPolicy> =>
    (await store.policies.get(agentId)) ?? (await store.policies.get('*')) ?? defaultPolicy();

  /**
   * Deliver a webhook event for an intent. No-op when no webhook URL is
   * configured; a delivery failure is audited (never thrown into the
   * request that produced the event), mirroring approval notifications.
   */
  const deliverWebhook = async (
    event: WebhookEvent,
    intent: RvnIntent,
    extra: { decision?: Decision; txid?: string; error?: string } = {},
  ): Promise<void> => {
    if (!webhookDispatcher.enabled) return;
    try {
      await webhookDispatcher.deliver(event, intent, extra);
      await store.audit.append('WEBHOOK_DELIVERY', intent.id, intent.agentId, { event });
    } catch (err) {
      app.log.error({ intentId: intent.id, event }, `webhook delivery failed: ${(err as Error).message}`);
      await store.audit.append('WEBHOOK_DELIVERY_FAILED', intent.id, intent.agentId, {
        event,
        error: (err as Error).message,
      });
    }
  };

  /**
   * Execute an intent against the node — shared by the immediate-execution
   * path and the approval path, so extra params (units, ipfs hashes,
   * reissuable flags) captured in intent.execParams at submit time are
   * replayed faithfully after a hold instead of being dropped.
   */
  const executeIntent = async (intent: RvnIntent): Promise<string> => {
    const p = intent.execParams ?? {};
    if (intent.kind === 'issue_asset') {
      return node.issueAsset({
        name: intent.assetName,
        qty: intent.qtyBaseUnits,
        toAddress: intent.destination,
        units: p.units,
        reissuable: p.reissuable,
        ipfsHash: p.ipfsHash,
      });
    }
    if (intent.kind === 'reissue_asset') {
      return node.reissueAsset({
        name: intent.assetName,
        qty: intent.qtyBaseUnits,
        toAddress: intent.destination,
        reissuable: p.reissuable,
        newUnits: p.newUnits,
        newIpfsHash: p.newIpfsHash,
      });
    }
    if (intent.kind === 'issue_subasset') {
      return node.issueSubAsset({
        name: intent.assetName,
        qty: intent.qtyBaseUnits,
        toAddress: intent.destination,
        units: p.units,
        reissuable: p.reissuable,
        ipfsHash: p.ipfsHash,
      });
    }
    if (intent.kind === 'issue_unique') {
      // Unique assets are singletons: qty is always '1' (enforced at the
      // route), units 0, never reissuable — the node takes no qty at all.
      return node.issueUniqueAsset({
        name: intent.assetName,
        toAddress: intent.destination,
        ipfsHash: p.ipfsHash,
      });
    }
    return node.transferAsset(intent.assetName, intent.qtyBaseUnits, intent.destination);
  };

  /**
   * Resolve a held intent — shared by POST /v1/intents/:id/approve,
   * POST /v1/intents/:id/deny, and the Telegram webhook's button callbacks.
   * Returns an HTTP-style { status, body } pair so every caller answers
   * consistently; the webhook always answers Telegram itself with 200 and
   * surfaces the outcome through answerCallbackQuery instead.
   */
  const resolveApproval = async (
    id: string,
    action: CallbackAction,
    approver: string,
  ): Promise<{ status: number; body: any }> => {
    const intent = await store.intents.getIntent(id);
    const decision = await store.intents.getDecision(id);
    if (!intent || !decision) return { status: 404, body: { error: 'unknown intent' } };
    if (decision.kind !== 'REQUIRE_APPROVAL') {
      return { status: 409, body: { error: `intent is ${decision.kind}, not pending approval` } };
    }
    if (isExpired(decision)) {
      return { status: 410, body: { error: 'decision expired — submit a new intent' } };
    }
    if (action === 'deny') {
      await store.audit.append('DENIAL', intent.id, intent.agentId, {
        approver,
        op: intent.kind,
        reasonCodes: decision.reasonCodes,
      });
      await store.intents.putDecision(id, {
        ...decision,
        kind: 'DENY',
        reasonCodes: ['DENIED_BY_OWNER', ...decision.reasonCodes],
      });
      await deliverWebhook('intent.denied', intent, {
        decision: { ...decision, kind: 'DENY', reasonCodes: ['DENIED_BY_OWNER', ...decision.reasonCodes] },
      });
      return { status: 200, body: { intent, denied: true, approver } };
    }
    await store.audit.append('APPROVAL', intent.id, intent.agentId, { approver });

    // Re-evaluate at approval time: caps may have moved since the hold.
    // History includes this intent itself; the detector excludes it by id.
    const fresh = await evaluateIntent(
      intent,
      await policyFor(intent.agentId),
      store.ledger,
      Date.now(),
      await store.intents.history(intent.agentId),
    );
    if (fresh.kind === 'DENY') {
      await store.audit.append('DECISION', intent.id, intent.agentId, {
        kind: 'DENY', reasonCodes: fresh.reasonCodes, atApproval: true,
      });
      await store.intents.putDecision(id, fresh);
      await deliverWebhook('intent.denied', intent, { decision: fresh });
      return { status: 403, body: { error: 'denied on re-evaluation', decision: fresh } };
    }
    try {
      const txid = await executeIntent(intent);
      if (createsSupply(intent.kind)) {
        await store.ledger.recordIssue(intent.agentId, BigInt(intent.qtyBaseUnits), Date.now());
      }
      await store.audit.append(MOCK ? 'EXECUTION_SKIPPED' : 'EXECUTION', intent.id, intent.agentId, { txid });
      // Mark the decision resolved so a second approve returns 409 instead of re-executing.
      await store.intents.putDecision(id, { ...fresh, kind: 'ALLOW', reasonCodes: ['APPROVED', ...fresh.reasonCodes] });
      await deliverWebhook('intent.executed', intent, { txid });
      return { status: 200, body: { intent, txid, mock: MOCK, approver } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.audit.append('EXECUTION_FAILED', intent.id, intent.agentId, { error: message });
      await deliverWebhook('intent.execution_failed', intent, { error: message });
      return { status: 502, body: { error: `node execution failed: ${message}` } };
    }
  };

  const submit = async (
    intent: RvnIntent,
    execute: () => Promise<string>,
    reply: any,
  ) => {
    // History is fetched before the intent is stored, so the anomaly
    // baseline is the agent's prior intents only — the current intent
    // never flags itself.
    const history = await store.intents.history(intent.agentId);
    const decision = await evaluateIntent(intent, await policyFor(intent.agentId), store.ledger, Date.now(), history);
    await store.intents.putIntent(intent);
    await store.intents.putDecision(intent.id, decision);
    await store.audit.append('DECISION', intent.id, intent.agentId, {
      kind: decision.kind,
      op: intent.kind,
      reasonCodes: decision.reasonCodes,
    });
    await deliverWebhook('intent.decided', intent, { decision });

    if (decision.kind === 'ALLOW') {
      try {
        const txid = await execute();
        if (createsSupply(intent.kind)) {
          await store.ledger.recordIssue(intent.agentId, BigInt(intent.qtyBaseUnits), Date.now());
        }
        await store.audit.append(MOCK ? 'EXECUTION_SKIPPED' : 'EXECUTION', intent.id, intent.agentId, { txid });
        await deliverWebhook('intent.executed', intent, { txid });
        return { intent, decision, txid, mock: MOCK };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store.audit.append('EXECUTION_FAILED', intent.id, intent.agentId, { error: message });
        await deliverWebhook('intent.execution_failed', intent, { error: message });
        return reply.code(502).send({ intent, decision, error: `node execution failed: ${message}` });
      }
    }
    if (decision.kind === 'REQUIRE_APPROVAL') {
      // Route the hold to the owner's channel (no-op when unconfigured).
      // A notification failure never fails the hold itself — it is audited.
      try {
        await approvalNotifier.notify(intent, decision);
        await store.audit.append('APPROVAL_NOTIFICATION', intent.id, intent.agentId, {
          transport: approvalNotifier.name,
          notified: approvalNotifier.enabled,
        });
      } catch (err) {
        app.log.error({ intentId: intent.id }, `approval notification failed: ${(err as Error).message}`);
        await store.audit.append('APPROVAL_NOTIFICATION_FAILED', intent.id, intent.agentId, {
          transport: approvalNotifier.name,
          error: (err as Error).message,
        });
      }
      return reply.code(202).send({
        intent,
        decision,
        message: 'held for human approval — POST /v1/intents/:id/approve',
      });
    }
    return reply.code(403).send({ intent, decision });
  };

  app.get('/v1/health', async () => ({
    ok: true,
    mock: MOCK,
    store: store.kind,
    approvals: {
      telegramConfigured: approvalNotifier.name === 'telegram',
      telegramWebhookSecretConfigured: WEBHOOK_SECRET !== undefined,
      perAgentChatRoutes: telegramConfig ? Object.keys(telegramConfig.chatIdsByAgent).length : 0,
    },
    webhooks: {
      configured: webhookDispatcher.enabled,
    },
    ...(await node.getInfo()),
  }));

  app.post('/v1/wallets', async () => {
    const address = await node.getNewAddress(`agent-${Date.now()}`);
    return { address };
  });

  app.post('/v1/assets/issue', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (!b.name || !b.qty || !b.toAddress) {
      return reply.code(400).send({ error: 'name, qty and toAddress are required' });
    }
    const intent: RvnIntent = {
      id: randomUUID(),
      agentId: String(b.agentId ?? 'agent-1'),
      kind: 'issue_asset',
      assetName: String(b.name).toUpperCase(),
      qtyBaseUnits: String(b.qty),
      destination: String(b.toAddress),
      requestedAtMs: Date.now(),
      // Captured so approval-time execution replays the same node params.
      execParams: {
        units: b.units !== undefined ? Number(b.units) : 0,
        reissuable: !((b.reissuable as unknown) === false || b.reissuable === 'false'),
        ipfsHash: b.ipfsHash,
      },
    };
    return submit(intent, () => executeIntent(intent), reply);
  });

  /**
   * Reissue additional supply of an existing reissuable asset, policy-gated
   * exactly like an issue (per-op cap, 24h issue budget, approval threshold,
   * destination allowlist, asset-name pattern). Optional extras:
   * reissuable (flip the reissuable flag), newUnits (0..8, replace decimals),
   * newIpfsHash (replace the asset's IPFS/Txid hash — ravend's params are
   * positional, so newUnits is required when newIpfsHash is set).
   */
  app.post('/v1/assets/reissue', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { name, qty, toAddress } = b;
    if (
      typeof name !== 'string' || !name ||
      typeof qty !== 'string' || !qty ||
      typeof toAddress !== 'string' || !toAddress
    ) {
      return reply.code(400).send({ error: 'name, qty and toAddress are required' });
    }
    const reissuable =
      b.reissuable === true || b.reissuable === 'true'
        ? true
        : b.reissuable === false || b.reissuable === 'false'
          ? false
          : undefined;
    const newUnits = b.newUnits === undefined ? undefined : Number(b.newUnits);
    const newIpfsHash =
      typeof b.newIpfsHash === 'string' && b.newIpfsHash ? b.newIpfsHash : undefined;
    if (newUnits !== undefined && (!Number.isInteger(newUnits) || newUnits < 0 || newUnits > 8)) {
      return reply.code(400).send({ error: 'newUnits must be an integer in 0..8' });
    }
    if (newIpfsHash !== undefined && newUnits === undefined) {
      return reply.code(400).send({
        error: 'newUnits is required when newIpfsHash is set (ravend params are positional)',
      });
    }
    const intent: RvnIntent = {
      id: randomUUID(),
      agentId: typeof b.agentId === 'string' && b.agentId ? b.agentId : 'agent-1',
      kind: 'reissue_asset',
      assetName: name.toUpperCase(),
      qtyBaseUnits: qty,
      destination: toAddress,
      requestedAtMs: Date.now(),
      execParams: { reissuable, newUnits, newIpfsHash },
    };
    return submit(intent, () => executeIntent(intent), reply);
  });

  /**
   * Issue a sub-asset under an existing parent asset, policy-gated exactly
   * like an issue (per-op cap, 24h issue budget, approval threshold,
   * destination allowlist) — except the asset-name pattern is applied to
   * every slash-separated segment, and the node requires the parent asset
   * to exist (unknown parent -> 502, like reissue's unknown asset). Nested
   * sub-assets (PARENT/CHILD/GRAND) work the same way: the immediate
   * parent must exist.
   */
  app.post('/v1/assets/issue-subasset', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { name, qty, toAddress } = b;
    if (
      typeof name !== 'string' || !name ||
      typeof qty !== 'string' || !qty ||
      typeof toAddress !== 'string' || !toAddress
    ) {
      return reply.code(400).send({ error: 'name, qty and toAddress are required' });
    }
    if (!name.includes('/')) {
      return reply.code(400).send({
        error: "sub-asset name must contain '/' (PARENT/SUB); use /v1/assets/issue for a root asset",
      });
    }
    const intent: RvnIntent = {
      id: randomUUID(),
      agentId: typeof b.agentId === 'string' && b.agentId ? b.agentId : 'agent-1',
      kind: 'issue_subasset',
      assetName: name.toUpperCase(),
      qtyBaseUnits: qty,
      destination: toAddress,
      requestedAtMs: Date.now(),
      execParams: {
        units: b.units !== undefined ? Number(b.units) : 0,
        reissuable: !((b.reissuable as unknown) === false || b.reissuable === 'false'),
        ipfsHash: typeof b.ipfsHash === 'string' ? b.ipfsHash : undefined,
      },
    };
    return submit(intent, () => executeIntent(intent), reply);
  });

  /**
   * Issue a unique asset (Ravencoin NFT) under an existing root asset,
   * policy-gated exactly like an issue (per-op cap, 24h issue budget,
   * approval threshold, destination allowlist) — except the name is
   * `ROOT#TAG`, the root must exist (unknown root -> 502, like reissue's
   * unknown asset), and the asset is a singleton: qty is fixed at 1, so
   * the body qty is optional and must be '1' when given; units are 0 and
   * the asset is never reissuable. The root may itself be a sub-asset
   * (`ART/DAVINCI#MONALISA`). An optional ipfsHash is attached.
   */
  app.post('/v1/assets/issue-unique', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { name, toAddress } = b;
    if (
      typeof name !== 'string' || !name ||
      typeof toAddress !== 'string' || !toAddress
    ) {
      return reply.code(400).send({ error: 'name and toAddress are required' });
    }
    if (!name.includes('#')) {
      return reply.code(400).send({
        error: "unique asset name must contain '#' (ROOT#TAG); use /v1/assets/issue for a root asset",
      });
    }
    if (b.qty !== undefined && String(b.qty) !== '1') {
      return reply.code(400).send({
        error: 'unique assets are singletons — qty must be 1 when given (and defaults to 1)',
      });
    }
    const intent: RvnIntent = {
      id: randomUUID(),
      agentId: typeof b.agentId === 'string' && b.agentId ? b.agentId : 'agent-1',
      kind: 'issue_unique',
      assetName: name.toUpperCase(),
      qtyBaseUnits: '1',
      destination: toAddress,
      requestedAtMs: Date.now(),
      execParams: {
        ipfsHash: typeof b.ipfsHash === 'string' ? b.ipfsHash : undefined,
      },
    };
    return submit(intent, () => executeIntent(intent), reply);
  });

  app.post('/v1/assets/transfer', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (!b.assetName || !b.qty || !b.destination) {
      return reply.code(400).send({ error: 'assetName, qty and destination are required' });
    }
    const intent: RvnIntent = {
      id: randomUUID(),
      agentId: String(b.agentId ?? 'agent-1'),
      kind: 'transfer_asset',
      assetName: String(b.assetName).toUpperCase(),
      qtyBaseUnits: String(b.qty),
      destination: String(b.destination),
      requestedAtMs: Date.now(),
    };
    return submit(intent, () => executeIntent(intent), reply);
  });

  app.get('/v1/assets', async (req) => {
    const q = req.query as { pattern?: string };
    return { assets: await node.listAssets(q.pattern ?? '*') };
  });

  app.get('/v1/assets/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const asset = await node.getAssetData(name);
    if (!asset) return reply.code(404).send({ error: 'unknown asset' });
    return asset;
  });

  app.post('/v1/intents/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, string>;
    const { status, body: out } = await resolveApproval(id, 'approve', body.approver ?? 'human');
    return reply.code(status).send(out);
  });

  app.post('/v1/intents/:id/deny', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, string>;
    const { status, body: out } = await resolveApproval(id, 'deny', body.approver ?? 'human');
    return reply.code(status).send(out);
  });

  /**
   * Dry-run an intent through the policy engine. Returns the decision the
   * policy WOULD make, without persisting the intent, recording issue spend,
   * appending to the audit chain, notifying approvers, or executing anything.
   * The returned decision id refers to nothing stored — approving it 404s.
   *
   * Body: { op: 'issue'|'transfer'|'reissue'|'subasset'|'unique', agentId?,
   *         assetName|name, qty, destination|toAddress }. Quantities are
   * base-unit decimal strings, like the rest of the API. Reissue,
   * sub-asset, and unique-asset issuance are simulated like an issue (same
   * caps/budget/thresholds); the node-level "asset exists" checks are not run.
   * For op:'unique' the qty is normalized to '1' when omitted or '1' (a
   * unique asset is a singleton); any other qty is a 400.
   */
  app.post('/v1/intents/simulate', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const op = b.op;
    if (op !== 'issue' && op !== 'transfer' && op !== 'reissue' && op !== 'subasset' && op !== 'unique') {
      return reply.code(400).send({ error: "op must be 'issue', 'transfer', 'reissue', 'subasset' or 'unique'" });
    }
    const assetName = String(b.assetName ?? b.name ?? '').toUpperCase();
    const destination = String(b.destination ?? b.toAddress ?? '');
    // Unique assets are singletons: qty defaults to '1'; anything else is a 400.
    const qty = op === 'unique' ? (b.qty === undefined ? '1' : b.qty) : b.qty;
    if (op === 'unique' && String(qty) !== '1') {
      return reply.code(400).send({ error: "op 'unique' is a singleton — qty must be 1 when given (and defaults to 1)" });
    }
    if (!assetName || !qty || !destination) {
      return reply
        .code(400)
        .send({ error: 'assetName, qty and destination are required (name and toAddress accepted as aliases)' });
    }
    try {
      BigInt(qty);
    } catch {
      return reply.code(400).send({ error: 'qty must be an integer decimal string in base units' });
    }
    const intent: RvnIntent = {
      id: `sim-${randomUUID()}`,
      agentId: String(b.agentId ?? 'agent-1'),
      kind:
        op === 'issue' ? 'issue_asset'
        : op === 'reissue' ? 'reissue_asset'
        : op === 'subasset' ? 'issue_subasset'
        : op === 'unique' ? 'issue_unique'
        : 'transfer_asset',
      assetName,
      qtyBaseUnits: String(qty),
      destination,
      requestedAtMs: Date.now(),
    };
    // Deliberately pure: no intents.set, no decisions.set, no ledger writes,
    // no audit entries, no approver notifications, no node calls.
    // History is read-only here: a simulation runs the same anomaly gate
    // as a real submit but never enters the baseline itself.
    const decision = await evaluateIntent(
      intent,
      await policyFor(intent.agentId),
      store.ledger,
      Date.now(),
      await store.intents.history(intent.agentId),
    );
    return {
      simulated: true,
      decision,
      note: 'dry run — no intent stored, no spend recorded, no audit entry, nothing executed',
    };
  });

  /**
   * Telegram webhook: receives callback queries when the owner taps the
   * Approve/Deny buttons on a hold notification. The secret header check
   * (when TELEGRAM_WEBHOOK_SECRET is set) proves the update came from
   * Telegram. The webhook always answers 200 so Telegram never retries; the
   * human outcome is surfaced through answerCallbackQuery and by editing the
   * hold message in place.
   */
  app.post('/v1/telegram/webhook', async (req, reply) => {
    if (WEBHOOK_SECRET) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (got !== WEBHOOK_SECRET) {
        return reply.code(403).send({ error: 'bad webhook secret' });
      }
    }
    const update = (req.body ?? {}) as TelegramUpdate;
    const cq = update.callback_query;
    if (!cq) return { ok: true, ignored: 'not a callback query' };

    const fromName = cq.from?.first_name ?? cq.from?.username ?? 'telegram';
    const approver = `telegram:${fromName}`;

    const answer = async (text: string): Promise<void> => {
      if (!telegramApi) {
        app.log.warn('telegram webhook: no bot token configured, cannot answer callback');
        return;
      }
      try {
        await telegramApi.answerCallbackQuery(cq.id, text);
      } catch (err) {
        app.log.warn({ err }, 'telegram answerCallbackQuery failed');
      }
    };

    const parsed = parseCallbackData(cq.data ?? '');
    if (!parsed) {
      await answer('Unknown action — tap the Approve/Deny buttons on a fresh hold message.');
      return { ok: true };
    }
    const { status, body } = await resolveApproval(parsed.intentId, parsed.action, approver);
    const intent = (body as { intent?: RvnIntent }).intent;
    const summary =
      status === 200 && parsed.action === 'approve'
        ? `Approved — txid ${(body as { txid?: string }).txid}`
        : status === 200
          ? 'Denied — the intent will not execute'
          : `Not resolved: ${(body as { error?: string }).error ?? `status ${status}`}`;
    await answer(summary);

    if (status === 200 && telegramApi && intent && cq.message) {
      const resolvedDecision = await store.intents.getDecision(parsed.intentId);
      try {
        await telegramApi.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          formatResolvedMessage(
            intent,
            resolvedDecision!,
            parsed.action,
            approver,
            (body as { txid?: string }).txid,
          ),
        );
      } catch (err) {
        app.log.warn({ err }, 'telegram editMessageText failed');
      }
    }
    return { ok: true };
  });

  app.get('/v1/intents/pending', async () => {
    const pending = await store.intents.pending();
    return { pending };
  });

  app.get('/v1/audit', async (req) => {
    const q = req.query as { limit?: string };
    return { chainValid: (await store.audit.verify()) === -1, entries: await store.audit.tail(Number(q.limit ?? 50)) };
  });

  // Static route first: Fastify matches it ahead of /v1/policies/:agentId,
  // so GET /v1/policies/presets never resolves 'presets' as an agent id.
  app.get('/v1/policies/presets', async () => ({ presets: POLICY_PRESETS }));

  app.get('/v1/policies/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    return policyFor(agentId);
  });

  /**
   * Apply a named preset to an agent, optionally with per-agent overrides
   * (any overridable policy field — caps, budgets, thresholds, destination
   * lists, name pattern, TTL). Same replace semantics as PUT
   * /v1/policies/:agentId, plus a POLICY_REPLACED audit entry naming the
   * preset. Unknown preset / field / malformed value -> 400, nothing stored.
   */
  app.post('/v1/policies/:agentId/preset', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const presetId = b.preset;
    if (typeof presetId !== 'string' || !presetId) {
      return reply.code(400).send({ error: "preset is required ('conservative', 'balanced' or 'permissive')" });
    }
    const overrides = b.overrides ?? {};
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      return reply.code(400).send({ error: 'overrides must be an object of policy fields' });
    }
    let policy: RvnPolicy;
    try {
      policy = applyPreset(presetId, agentId, overrides as Record<string, unknown>);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    await store.policies.set(policy);
    await store.audit.append('DECISION', 'policy-update', agentId, {
      kind: 'POLICY_REPLACED',
      preset: presetId,
      overrides: Object.keys(overrides as Record<string, unknown>),
    });
    return { preset: presetId, policy };
  });

  app.put('/v1/policies/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const b = req.body as Partial<RvnPolicy>;
    const required = [
      'maxIssueQtyBaseUnits', 'approvalAboveIssueQtyBaseUnits', 'dailyIssueBudgetBaseUnits',
      'maxTransferQtyBaseUnits', 'approvalAboveTransferQtyBaseUnits', 'allowedDestinations',
      'blockedDestinations', 'assetNamePattern', 'decisionTtlSeconds',
    ];
    if (b.version !== 1 || b.agentId !== agentId) {
      return reply.code(400).send({ error: 'policy needs version:1 and a matching agentId' });
    }
    for (const k of required) {
      if ((b as Record<string, unknown>)[k] === undefined) {
        return reply.code(400).send({ error: `missing policy field: ${k}` });
      }
    }
    try {
      new RegExp(b.assetNamePattern!);
    } catch {
      return reply.code(400).send({ error: 'assetNamePattern is not a valid regex' });
    }
    await store.policies.set(b as RvnPolicy);
    await store.audit.append('DECISION', 'policy-update', agentId, { kind: 'POLICY_REPLACED' });
    return { policy: b };
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
