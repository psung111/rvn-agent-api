import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import 'dotenv/config';
import {
  defaultPolicy,
  evaluateIntent,
  InMemoryIssueLedger,
  isExpired,
  type Decision,
  type RvnIntent,
  type RvnPolicy,
} from './policy/index.js';
import { AuditLog } from './audit.js';
import { notifierFromEnv, telegramConfigFromEnv } from './approvals/notifier.js';
import { parseCallbackData, formatResolvedMessage, type CallbackAction } from './approvals/callbacks.js';
import { TelegramApi } from './approvals/telegram-api.js';
import { MockRvnNode } from './rvn/mock.js';
import { RvnRpcClient } from './rvn/client.js';
import type { RvnNode } from './rvn/types.js';

const MOCK = process.env.MOCK_RVN !== 'false';
const PORT = Number(process.env.PORT ?? 3001);

// In-memory state (Postgres when this grows up).
const policies = new Map<string, RvnPolicy>([['*', defaultPolicy()]]);
const intents = new Map<string, RvnIntent>();
const decisions = new Map<string, Decision>();
const ledger = new InMemoryIssueLedger();
const audit = new AuditLog();
const approvalNotifier = notifierFromEnv();
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

  const policyFor = (agentId: string) => policies.get(agentId) ?? policies.get('*')!;

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
    const intent = intents.get(id);
    const decision = decisions.get(id);
    if (!intent || !decision) return { status: 404, body: { error: 'unknown intent' } };
    if (decision.kind !== 'REQUIRE_APPROVAL') {
      return { status: 409, body: { error: `intent is ${decision.kind}, not pending approval` } };
    }
    if (isExpired(decision)) {
      return { status: 410, body: { error: 'decision expired — submit a new intent' } };
    }
    if (action === 'deny') {
      audit.append('DENIAL', intent.id, intent.agentId, {
        approver,
        op: intent.kind,
        reasonCodes: decision.reasonCodes,
      });
      decisions.set(id, {
        ...decision,
        kind: 'DENY',
        reasonCodes: ['DENIED_BY_OWNER', ...decision.reasonCodes],
      });
      return { status: 200, body: { intent, denied: true, approver } };
    }
    audit.append('APPROVAL', intent.id, intent.agentId, { approver });

    // Re-evaluate at approval time: caps may have moved since the hold.
    const fresh = evaluateIntent(intent, policyFor(intent.agentId), ledger);
    if (fresh.kind === 'DENY') {
      audit.append('DECISION', intent.id, intent.agentId, {
        kind: 'DENY', reasonCodes: fresh.reasonCodes, atApproval: true,
      });
      decisions.set(id, fresh);
      return { status: 403, body: { error: 'denied on re-evaluation', decision: fresh } };
    }
    try {
      const txid =
        intent.kind === 'issue_asset'
          ? await node.issueAsset({
              name: intent.assetName, qty: intent.qtyBaseUnits, toAddress: intent.destination,
            })
          : await node.transferAsset(intent.assetName, intent.qtyBaseUnits, intent.destination);
      if (intent.kind === 'issue_asset') {
        ledger.recordIssue(intent.agentId, BigInt(intent.qtyBaseUnits), Date.now());
      }
      audit.append(MOCK ? 'EXECUTION_SKIPPED' : 'EXECUTION', intent.id, intent.agentId, { txid });
      // Mark the decision resolved so a second approve returns 409 instead of re-executing.
      decisions.set(id, { ...fresh, kind: 'ALLOW', reasonCodes: ['APPROVED', ...fresh.reasonCodes] });
      return { status: 200, body: { intent, txid, mock: MOCK, approver } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit.append('EXECUTION_FAILED', intent.id, intent.agentId, { error: message });
      return { status: 502, body: { error: `node execution failed: ${message}` } };
    }
  };

  const submit = async (
    intent: RvnIntent,
    execute: () => Promise<string>,
    reply: any,
  ) => {
    const decision = evaluateIntent(intent, policyFor(intent.agentId), ledger);
    intents.set(intent.id, intent);
    decisions.set(intent.id, decision);
    audit.append('DECISION', intent.id, intent.agentId, {
      kind: decision.kind,
      op: intent.kind,
      reasonCodes: decision.reasonCodes,
    });

    if (decision.kind === 'ALLOW') {
      try {
        const txid = await execute();
        if (intent.kind === 'issue_asset') {
          ledger.recordIssue(intent.agentId, BigInt(intent.qtyBaseUnits), Date.now());
        }
        audit.append(MOCK ? 'EXECUTION_SKIPPED' : 'EXECUTION', intent.id, intent.agentId, { txid });
        return { intent, decision, txid, mock: MOCK };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.append('EXECUTION_FAILED', intent.id, intent.agentId, { error: message });
        return reply.code(502).send({ intent, decision, error: `node execution failed: ${message}` });
      }
    }
    if (decision.kind === 'REQUIRE_APPROVAL') {
      // Route the hold to the owner's channel (no-op when unconfigured).
      // A notification failure never fails the hold itself — it is audited.
      try {
        await approvalNotifier.notify(intent, decision);
        audit.append('APPROVAL_NOTIFICATION', intent.id, intent.agentId, {
          transport: approvalNotifier.name,
          notified: approvalNotifier.enabled,
        });
      } catch (err) {
        app.log.error({ intentId: intent.id }, `approval notification failed: ${(err as Error).message}`);
        audit.append('APPROVAL_NOTIFICATION_FAILED', intent.id, intent.agentId, {
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
    approvals: {
      telegramConfigured: approvalNotifier.name === 'telegram',
      telegramWebhookSecretConfigured: WEBHOOK_SECRET !== undefined,
      perAgentChatRoutes: telegramConfig ? Object.keys(telegramConfig.chatIdsByAgent).length : 0,
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
    };
    return submit(
      intent,
      () =>
        node.issueAsset({
          name: intent.assetName,
          qty: intent.qtyBaseUnits,
          toAddress: intent.destination,
          units: b.units !== undefined ? Number(b.units) : 0,
          reissuable: b.reissuable !== 'false',
          ipfsHash: b.ipfsHash,
        }),
      reply,
    );
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
    return submit(
      intent,
      () => node.transferAsset(intent.assetName, intent.qtyBaseUnits, intent.destination),
      reply,
    );
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
      try {
        await telegramApi.editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          formatResolvedMessage(
            intent,
            decisions.get(parsed.intentId)!,
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
    const pending: Array<{ intent: RvnIntent; decision: Decision }> = [];
    for (const [id, intent] of intents) {
      const d = decisions.get(id)!;
      if (d.kind === 'REQUIRE_APPROVAL' && !isExpired(d)) pending.push({ intent, decision: d });
    }
    return { pending };
  });

  app.get('/v1/audit', async (req) => {
    const q = req.query as { limit?: string };
    return { chainValid: audit.verify() === -1, entries: audit.tail(Number(q.limit ?? 50)) };
  });

  app.get('/v1/policies/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    return policyFor(agentId);
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
    policies.set(agentId, b as RvnPolicy);
    audit.append('DECISION', 'policy-update', agentId, { kind: 'POLICY_REPLACED' });
    return { policy: b };
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
