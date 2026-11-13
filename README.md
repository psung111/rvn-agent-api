# rvn-agent-api — Phase 0 Spike

An agent-facing API for Ravencoin assets, with a policy engine in front. An AI agent
never touches the node directly: it submits an **intent** (issue / transfer), the policy
engine decides **ALLOW / REQUIRE_APPROVAL / DENY**, and only allowed operations reach
the chain. Every step lands in a hash-chained audit log.

This is the "radical simplicity" play: Ravencoin's asset layer is dead simple — no smart
contracts, no gas estimation — which makes it a natural fit for agents that need
predictable primitives. This API is the missing developer layer on top of it.

```
┌─────────┐  POST /v1/assets/…   ┌──────────────┐  ALLOW   ┌──────────────┐
│  Agent  │ ──────────────────► │  Policy API  │ ────────► │ Ravencoin    │
│  (LLM)  │                      │  (Fastify)   │           │ node / mock  │
└─────────┘                      └──────┬───────┘           └──────────────┘
                                        │
                                  policy engine            ┌──────────────┐
                             (ALLOW/APPROVE/DENY) ───────► │ Audit log    │
                                                           │ hash-chained │
                                                           └──────────────┘
```

## Quickstart

```bash
pnpm install
cp .env.example .env   # MOCK_RVN=true by default — in-memory node, no chain
```

Terminal 1 — start the API:

```bash
pnpm dev
```

Terminal 2 — run the demo:

```bash
pnpm demo
```

Expected: issue ALLOWs, over-cap issue DENYs, bad asset name DENYs, transfer to an
unknown address holds for approval then executes on approve, and the audit chain
verifies clean.

## API

| Method | Path | What |
|---|---|---|
| GET | `/v1/health` | node info (mock or real) |
| POST | `/v1/wallets` | provision an agent wallet address |
| POST | `/v1/assets/issue` | issue a new asset (policy-gated) |
| POST | `/v1/assets/reissue` | reissue more supply of an existing reissuable asset (policy-gated like an issue; optional `reissuable`, `newUnits` 0–8, `newIpfsHash` — `newUnits` required when `newIpfsHash` is set) |
| POST | `/v1/assets/transfer` | transfer an asset (policy-gated) |
| GET | `/v1/assets?pattern=` | list assets |
| GET | `/v1/assets/:name` | asset details |
| POST | `/v1/intents/simulate` | dry-run an issue/reissue/transfer through policy — no side effects |
| POST | `/v1/intents/:id/approve` | approve a held intent (body: optional `approver` label; a quorum hold returns 202 with `approvalsReceived`/`approvalsRequired` until N distinct approvers have approved, then executes; when the hold carries a roster (`quorumApprovers`, M identities) only roster members count — anyone else gets 403) |
| POST | `/v1/intents/:id/deny` | deny a held intent (any single approver ends the hold) |
| GET | `/v1/intents/pending` | intents awaiting approval |
| GET | `/v1/audit` | hash-chained audit trail (`chainValid`) |
| POST | `/v1/audit/archive` | archive entries older than `beforeMs` (epoch ms; omitted = retention policy, `RVN_AUDIT_RETENTION_DAYS`, default 90 days) to a JSON file with a chain-verification proof, then prune them from the live chain (newest entry always kept as the anchor) |
| GET | `/v1/policies/:agentId` | fetch an agent's policy |
| PUT | `/v1/policies/:agentId` | replace an agent's policy |
| GET | `/v1/policies/presets` | list the policy presets (conservative / balanced / permissive) |
| POST | `/v1/policies/:agentId/preset` | apply a preset to an agent, with optional per-agent `overrides` |
| GET | `/v1/ratelimit/:agentId` | rate-limit stats for an agent (read-only) |
| GET | `/v1/anomaly/:agentId?windowHours=` | anomaly stats for an agent: holds raised by signal, holds still pending, thresholds in force (read-only) |
| GET | `/v1/metrics` | ops metrics: decision counts by kind and reason code, rate-limit 429s by agent and kind, webhook deliveries by endpoint, approval hold age, store backend (read-only) |
| POST | `/v1/admin/api-keys` | issue an API key for an agent (operator key only; the raw key is returned once) |
| GET | `/v1/admin/api-keys` | list issued keys (operator key only; prefixes and timestamps, never hashes) |
| POST | `/v1/admin/api-keys/:id/revoke` | revoke a key immediately (operator key only) |

Policy defaults (`src/policy/presets.ts`): per-issue cap 100k units, approval above
10k, 24h issue budget 500k, transfers to unknown destinations require approval,
asset names must match Ravencoin's `^[A-Z0-9._]{3,30}$`. Tune to taste — that's the
whole product.

## API-key authentication

The REST surface is unauthenticated by default (the localhost demo posture).
Turn auth on with `RVN_AUTH_ENABLED=true`, or by setting an operator key:

```bash
RVN_OPERATOR_API_KEY=rvn_your-long-operator-key-here pnpm dev
```

With auth on, every `/v1` route except `/v1/health` (liveness) and
`/v1/telegram/webhook` (its own secret check) requires
`Authorization: Bearer <key>`. Keys are issued per agentId through the
admin surface above — only the operator key may use it — and stored as
SHA-256 hashes, so the raw key is shown once at issue time and never
again. A wrong or missing key gets 401 and the attempt is audited as
`AUTH_FAILED` (key prefix only, never the key). A non-operator key may
only act as its own agent: submitting or reading policy as another agent
gets 403, and omitting `agentId` defaults to the key's agent. Revoking a
key takes effect immediately. `/v1/health` reports the auth mode and the
live-key count. (MCP/LangChain key passthrough is the next slice; until
then those adapters need auth off.)

## MCP server

AI agents can call the API natively instead of raw REST. Start the REST API
(`pnpm dev`), then add this to your MCP client config:

```json
"rvn-agent-api": {
  "command": "pnpm",
  "args": ["--dir", "/path/to/rvn-agent-api", "mcp"],
  "env": { "RVN_API_URL": "http://127.0.0.1:3001" }
}
```

Tools: `issue_asset`, `reissue_asset`, `transfer_asset`, `simulate_intent`,
`approve_intent`, `deny_intent`, `pending_intents`, `list_assets`, `get_audit`,
`get_policy`, `set_policy`. Every tool
call runs through the policy engine and audit exactly like a REST call —
the MCP server is transport only. Verify with `pnpm mcp-smoke` (API must be
running).

## LangChain tools (Python agents)

`langchain_rvn/` wraps the same REST API as LangChain tools — same
policy-engine enforcement, same audit trail, no MCP hop needed:

```python
from langchain_rvn import RvnApiClient, get_tools

tools = get_tools(RvnApiClient("http://127.0.0.1:3001", agent_id="agent-1"))
# hand `tools` to any LangChain agent executor
```

The client (`client.py`) is stdlib-only and covers every route; the 17
tools (`tools.py`) return JSON strings — decisions with reason codes, held
intent ids, or `{"error", "status"}` objects. Install from a checkout with
`pip install ./langchain_rvn` (the package builds a valid wheel and sdist;
it is not on PyPI yet). A worked agent-executor example lives at
`langchain_rvn/examples/agent_executor.py` — it runs a deterministic
tool-calling loop (simulate → issue → audit) against a local mock-node
API with no LLM key. Verify with `pnpm test:langchain`, which boots the
API on the mock node and exercises the client and every tool.

## Telegram approval notifications

Every `REQUIRE_APPROVAL` intent fans out to an `ApprovalNotifier`
(`src/approvals/notifier.ts`). Set these env vars to get a Telegram ping on
every hold:

```bash
TELEGRAM_APPROVAL_BOT_TOKEN=<bot token from @BotFather>
TELEGRAM_APPROVAL_CHAT_ID=<your chat id>
```

The message carries the intent id, op, asset, qty, destination, reason codes,
expiry, and a copy-paste approve `curl`. The token never lands in logs, audit
entries, or message text; notification failures are audited as
`APPROVAL_NOTIFICATION_FAILED` and never fail the hold itself. Unset both vars
and notifications stay disabled — the intent just waits for
`POST /v1/intents/:id/approve`. `/v1/health` reports
`approvals.telegramConfigured`. Hold notifications also carry inline
Approve/Deny buttons: taps arrive as callback queries on
`POST /v1/telegram/webhook` and resolve the intent the same way the HTTP
routes do.

## Webhooks

Set `RVN_WEBHOOK_URL` and the API POSTs decision/execution events to it
as JSON: `intent.decided` (every ALLOW / REQUIRE_APPROVAL / DENY),
`intent.executed` (with txid), `intent.denied`, and
`intent.execution_failed` (with the error). Set `RVN_WEBHOOK_SECRET` as
well and every delivery carries `X-Rvn-Signature: sha256=<hex>`
(HMAC-SHA256 over the raw body) plus `X-Rvn-Event`, so a receiver can
prove the event came from this API. Delivery failures are audited as
`WEBHOOK_DELIVERY_FAILED` and never fail the request that produced the
event; unset the URL and webhooks stay disabled. `/v1/health` reports
`webhooks.configured`. Verify with `pnpm test:webhooks`, which drives
the real API against a stub receiver.

## Going live (testnet)

1. Run `ravend` with `-server=1 -testnet=1`, let it sync.
2. Fill in `.env`: `MOCK_RVN=false`, `RVN_RPC_URL`, `RVN_RPC_USER`, `RVN_RPC_PASS`.
3. Restart. The same API now drives real `issue` / `transfer` RPCs.
4. Verify RPC shapes against your node: `ravend help issue` — parameter order matters
   and varies slightly across versions; see `src/rvn/client.ts`.

## Persistence

By default everything (policies, intents, decisions, issue ledger, audit
chain) lives in process memory — restart the API and it's gone. To persist:

1. `docker compose up -d` (postgres:16-alpine)
2. `export RVN_DATABASE_URL=postgres://rvn:rvn@localhost:5432/rvn_agent_api`
3. Restart the API. `/v1/health` reports `"store": "postgres"` and the
   applied schema versions under `"migrations"`. The API runs the
   versioned migrations in `src/store/migrations/` at startup (tracked
   in the `schema_migrations` table); to evolve the schema, add a
   `NNNN_name.sql` file there and restart — each migration runs in its
   own transaction, and a failed or inconsistent migration stops startup
   with a clear error instead of silently falling back to memory.
   `audit_entries` is monthly range-partitioned on `at_ms` (one partition
   per UTC month, created on demand at append time), so time-range reads
   prune partitions and old months can be archived or dropped as whole
   partitions; `/v1/health` reports `"audit": { "partitioned": true }`.

If the database is unreachable the API still boots on the in-memory store and
logs a warning — nothing is persisted in that mode. `pnpm test:store` runs the
store test suite; set `TEST_DATABASE_URL` to also run it against a live Postgres.

## What's stubbed

- **Approvals channel** — approvals are an HTTP call plus Telegram hold
  notifications with inline Approve/Deny buttons.
- **Unique assets / sub-assets** — `reissue` is exposed (`POST /v1/assets/reissue`,
  `reissue_asset` MCP tool); `issueunique` and sub-asset issuance aren't yet.
- **Agent adapters** — LangChain tool wrapper around the REST API (MCP server done in v0.2.0).

## Roadmap

Phase 0 (this repo) → Phase 1 (Postgres, approvals channel, live testnet hardening,
MCP server) → Phase 2 (fleet provisioning, anomaly detection, mainnet-ready ops).

## License

Copyright (C) 2026 Paul Sung.

This project is licensed under the **GNU Affero General Public License v3.0**
(see [LICENSE](LICENSE)). In plain terms: you may use, modify, and distribute
this code, but if you run a modified version as a network service, you must
make your source changes available under the same license.

**Commercial licensing:** if AGPL doesn't fit your use — for example, embedding
this in a closed commercial product or service — commercial licenses are
available from the copyright holder. Open an issue on this repository to ask.
