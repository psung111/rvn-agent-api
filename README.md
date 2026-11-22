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
| GET | `/v1/openapi.json` | this OpenAPI contract (public — no key needed, even with auth on) |
| GET | `/v1/docs` | the same contract as a human-readable HTML page (public — no key needed, even with auth on) |
| POST | `/v1/wallets` | provision an agent wallet address |
| GET | `/v1/wallet/balances` | the wallet's RVN balance plus every asset balance it holds (nonzero only; read-only) |
| POST | `/v1/assets/issue` | issue a new asset (policy-gated) |
| POST | `/v1/assets/reissue` | reissue more supply of an existing reissuable asset (policy-gated like an issue; optional `reissuable`, `newUnits` 0–8, `newIpfsHash` — `newUnits` required when `newIpfsHash` is set) |
| POST | `/v1/assets/issue-subasset` | issue a sub-asset under an existing parent (policy-gated like an issue; name must contain `/`) |
| POST | `/v1/assets/issue-unique` | issue a unique asset, `ROOT#TAG` (policy-gated like an issue; singleton — qty fixed at 1) |
| POST | `/v1/assets/transfer` | transfer an asset (policy-gated) |
| GET | `/v1/assets?pattern=` | list assets |
| GET | `/v1/assets/:name` | asset details |
| POST | `/v1/intents/simulate` | dry-run an issue/reissue/transfer through policy — no side effects; balance-aware (a policy ALLOW the wallet cannot fund DENYs with `INSUFFICIENT_ASSET_BALANCE` / `INSUFFICIENT_RVN_BALANCE`, with a `funding` object carrying the requirement and the balance seen) |
| POST | `/v1/intents/:id/approve` | approve a held intent (body: optional `approver` label; a quorum hold returns 202 with `approvalsReceived`/`approvalsRequired` until N distinct approvers have approved, then executes; when the hold carries a roster (`quorumApprovers`, M identities) only roster members count — anyone else gets 403) |
| POST | `/v1/intents/:id/deny` | deny a held intent (any single approver ends the hold) |
| GET | `/v1/intents/pending` | intents awaiting approval |
| POST | `/v1/telegram/webhook` | Telegram Approve/Deny button callbacks (its own secret check, no API key) |
| GET | `/v1/audit` | hash-chained audit trail (`chainValid`) |
| POST | `/v1/audit/archive` | archive entries older than `beforeMs` (epoch ms; omitted = retention policy, `RVN_AUDIT_RETENTION_DAYS`, default 90 days) to a JSON file with a chain-verification proof, then prune them from the live chain (newest entry always kept as the anchor) |
| GET | `/v1/policies/:agentId` | fetch an agent's policy |
| PUT | `/v1/policies/:agentId` | replace an agent's policy (the superseded policy is kept in history) |
| GET | `/v1/policies/presets` | list the policy presets (conservative / balanced / permissive) |
| POST | `/v1/policies/:agentId/preset` | apply a preset to an agent, with optional per-agent `overrides` |
| GET | `/v1/policies/:agentId/history` | superseded policy versions for an agent, newest first (`?limit=`, default 10) |
| POST | `/v1/policies/:agentId/rollback` | restore a history version as the live policy (body: `versionId`); the replaced policy is archived, so a rollback is itself undoable |
| GET | `/v1/ratelimit/:agentId` | rate-limit stats for an agent (read-only) |
| GET | `/v1/anomaly/:agentId?windowHours=` | anomaly stats for an agent: holds raised by signal, holds still pending, thresholds in force (read-only) |
| GET | `/v1/metrics` | ops metrics: decision counts by kind and reason code, rate-limit 429s by agent and kind, webhook deliveries by endpoint, approval hold age, store backend (read-only) |
| POST | `/v1/admin/api-keys` | issue an API key for an agent (operator key only; the raw key is returned once; optional `scopes: ["read"]` for a read-only key) |
| GET | `/v1/admin/api-keys` | list issued keys (operator key only; prefixes and timestamps, never hashes) |
| POST | `/v1/admin/api-keys/:id/revoke` | revoke a key immediately (operator key only) |

Policy defaults (`src/policy/presets.ts`): per-issue cap 100k units, approval above
10k, 24h issue budget 500k, transfers to unknown destinations require approval,
asset names must match Ravencoin's `^[A-Z0-9._]{3,30}$`. Tune to taste — that's the
whole product.

## OpenAPI contract

The machine-readable contract for the API above lives at
`GET /v1/openapi.json` (OpenAPI 3.0.3, hand-maintained in `src/openapi.ts`) —
every route, decision shape, reason code, and error status. Code against it
instead of guessing request shapes. The same contract is served as a
human-readable HTML page at `GET /v1/docs` (generated from the spec on every
request by `src/docs.ts` — no external assets, no JavaScript — so it can
never drift from it). `pnpm test:openapi` asserts it never
drifts from the server: it parses the route registrations out of
`src/server.ts` and requires the spec's method+path set to match exactly,
and probes every spec operation against a booted API. `pnpm test:docs`
asserts the docs page lists every spec operation. The MCP server
(`get_openapi` and `get_docs` tools) and the LangChain client
(`get_openapi()` and `get_docs()`) expose the
same document, so agents can fetch the contract through either adapter.

## Balance-aware simulate

`POST /v1/intents/simulate` answers the policy question — and the funding
question. When the policy decision is ALLOW, the wallet balance is checked
too (read-only node lookups): a transfer needs the wallet to hold at least
the qty of the asset; a supply-creating op needs enough RVN for the
Ravencoin issuance fee (issue 500 RVN, reissue 100 RVN, sub-asset 100 RVN,
unique asset 5 RVN — consensus fees, not policy). An ALLOW the wallet
cannot fund comes back as DENY with `INSUFFICIENT_ASSET_BALANCE` /
`INSUFFICIENT_RVN_BALANCE`, and the `funding` object carries the
requirement (`asset`, `requiredBaseUnits`), the balance seen
(`balanceBaseUnits`, null when the wallet holds none of the asset), and
whether it funded — so agents stop submitting doomed intents. A policy
DENY or hold is reported as-is and carries no `funding` object (the check
runs only on ALLOW), and a node that cannot answer leaves the ALLOW
untouched (`funded: null`). The variable per-transaction miner fee is not
checked. On the mock node the wallet starts at 1,000,000 RVN (override
with `MOCK_RVN_BALANCE_BASE_UNITS`, base units) and the issuance fee is
debited on every real issue/reissue/sub-asset/unique call, so the check
and the execution agree; on a real node the balances come from
`listmyassets` / `getbalance`.

The same check also gates real submits: a policy ALLOW the wallet cannot
fund is refused before execution (403 DENY with the funding reason code
and the `funding` object in the body, audited as a `DECISION` — nothing
executed, no `EXECUTION_FAILED` entry) instead of failing at the node
with a 502. A hold that became unfundable while it waited is caught the
same way at approval time: approving it returns 403 with the funding
DENY, audited as a decision with `atApproval: true`, and the hold ends.

## Wallet balances

`GET /v1/wallet/balances` answers "what can this wallet fund" in one
read-only call: the RVN balance plus every asset balance the wallet
holds, all as decimal strings in base units, assets sorted by name.
Only assets with a nonzero wallet balance are listed — an asset fully
transferred out disappears from the list. Polling it writes nothing (no
intents, no audit entries), so it is safe for monitoring agents; a node
that cannot answer returns 502. The MCP server (`get_wallet_balances`)
and the LangChain client (`get_wallet_balances()`) expose the same read.

## API-key authentication

The REST surface is unauthenticated by default (the localhost demo posture).
Turn auth on with `RVN_AUTH_ENABLED=true`, or by setting an operator key:

```bash
RVN_OPERATOR_API_KEY=rvn_your-long-operator-key-here pnpm dev
```

With auth on, every `/v1` route except `/v1/health` (liveness),
`/v1/openapi.json` (the public contract), `/v1/docs` (its human-readable
rendering), and
`/v1/telegram/webhook` (its own secret check) requires
`Authorization: Bearer <key>`. Keys are issued per agentId through the
admin surface above — only the operator key may use it — and stored as
SHA-256 hashes, so the raw key is shown once at issue time and never
again. A wrong or missing key gets 401 and the attempt is audited as
`AUTH_FAILED` (key prefix only, never the key). A non-operator key may
only act as its own agent: submitting or reading policy as another agent
gets 403, and omitting `agentId` defaults to the key's agent. Revoking a
key takes effect immediately. `/v1/health` reports the auth mode and the
live-key count.

Per-key scopes (v0.31.0): issue a key with an optional `scopes` array —
`['read']` for a read-only key, `['write']` for a write-only one, omitted
(or `['read', 'write']`) for full access:

```bash
curl -X POST http://127.0.0.1:3001/v1/admin/api-keys \
  -H "Authorization: Bearer $RVN_OPERATOR_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"agentId": "monitor", "scopes": ["read"]}'
```

The gate is method-based: `read` allows GET/HEAD routes, `write` allows
everything else (POST/PUT/DELETE). A read-only key can list assets,
read policies, and check metrics, but a submit, policy PUT, approve,
or even a simulate (it is a POST, despite having no side effects) gets
403, audited as `AUTH_FAILED` with reason `scope_insufficient`. Keys
issued before scopes existed carry no scope list and keep full access.
The operator key is always full-scope. Listings show each key's scopes;
an invalid scope list (unknown scope, empty array, non-array) is a 400
at issue time, so a half-valid request can never silently mint a
full-access key. The adapters pass the key through: the MCP server reads
`RVN_API_KEY`, and the LangChain client takes an `api_key` argument (or
the same `RVN_API_KEY` env var) and sends it as a Bearer token on every
request — without it, an auth-on API answers 401 and the tools surface
that as an error instead of a success-shaped payload. A scoped key rides
the same path: a read-only key's MCP/LangChain submits surface the 403
as an error, while its reads work unchanged.

## MCP server

AI agents can call the API natively instead of raw REST. Start the REST API
(`pnpm dev`), then add this to your MCP client config:

```json
"rvn-agent-api": {
  "command": "pnpm",
  "args": ["--dir", "/path/to/rvn-agent-api", "mcp"],
  "env": {
    "RVN_API_URL": "http://127.0.0.1:3001",
    "RVN_API_KEY": "rvn_<key issued for the agent>"
  }
}
```

With auth on, `RVN_API_KEY` is required — without it every tool call
401s. Verify with `pnpm mcp-smoke` (API must be running, auth off) and
`pnpm test:mcp-auth` (boots its own auth-on API).

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

# With auth on, pass api_key=... (or set RVN_API_KEY); without it the
# tools return {"error": ..., "status": 401}.
tools = get_tools(RvnApiClient("http://127.0.0.1:3001", agent_id="agent-1",
                               api_key="rvn_<key issued for the agent>"))
```

The client (`client.py`) is stdlib-only and covers every route; the 21
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

## Hold-aging alerts

A hold that sits unapproved is silent by default — no one is re-pinged.
Set `RVN_HOLD_ALERT_AFTER_MS` (default 3600000 = 1h) and the server
re-notifies the approvers once per hold after it has sat that long: a
Telegram reminder (same Approve/Deny buttons, plus the hold's age and
the quorum progress, e.g. `approvals: 1/2 of 3`) and an
`intent.hold_aging` webhook event carrying `{ ageMs, quorum? }`.
The alert is audited as `HOLD_AGING_ALERT`, and approving or denying
the hold clears it — a resolved hold never alerts. The sweep runs
inside the server every `RVN_HOLD_ALERT_CHECK_MS` (default 60000) and
once at boot, so a restart re-alerts holds that aged while the server
was down; the "once" is a flag persisted on the decision itself, so a
restart cannot lose it or double-fire it. `/v1/health` reports
`holdAging` (threshold, interval, whether any channel is configured).
Verify with `pnpm test:hold-aging`.

## Webhooks

Set `RVN_WEBHOOK_URL` and the API POSTs decision/execution events to it
as JSON: `intent.decided` (every ALLOW / REQUIRE_APPROVAL / DENY),
`intent.executed` (with txid), `intent.denied`,
`intent.execution_failed` (with the error), and `intent.hold_aging`
(once per hold that sits unapproved past the threshold — see
Hold-aging alerts; carries the hold's age and quorum progress). Set
`RVN_WEBHOOK_SECRET` as well and every delivery carries
`X-Rvn-Signature: sha256=<hex>` (HMAC-SHA256 over the raw body) plus
`X-Rvn-Event`, so a receiver can prove the event came from this API.
Delivery failures are audited as `WEBHOOK_DELIVERY_FAILED` and never
fail the request that produced the event; unset the URL and webhooks
stay disabled. `/v1/health` reports `webhooks.configured`. Verify with
`pnpm test:webhooks`, which drives the real API against a stub receiver.

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
