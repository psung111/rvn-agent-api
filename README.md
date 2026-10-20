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
| POST | `/v1/assets/transfer` | transfer an asset (policy-gated) |
| GET | `/v1/assets?pattern=` | list assets |
| GET | `/v1/assets/:name` | asset details |
| POST | `/v1/intents/:id/approve` | approve a held intent |
| GET | `/v1/intents/pending` | intents awaiting approval |
| GET | `/v1/audit` | hash-chained audit trail (`chainValid`) |
| GET | `/v1/policies/:agentId` | fetch an agent's policy |
| PUT | `/v1/policies/:agentId` | replace an agent's policy |

Policy defaults (`src/policy/presets.ts`): per-issue cap 100k units, approval above
10k, 24h issue budget 500k, transfers to unknown destinations require approval,
asset names must match Ravencoin's `^[A-Z0-9._]{3,30}$`. Tune to taste — that's the
whole product.

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

Tools: `issue_asset`, `transfer_asset`, `approve_intent`, `pending_intents`,
`list_assets`, `get_audit`, `get_policy`, `set_policy`. Every tool
call runs through the policy engine and audit exactly like a REST call —
the MCP server is transport only. Verify with `pnpm mcp-smoke` (API must be
running).

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
`approvals.telegramConfigured`. Inline Approve/Deny buttons (inbound Telegram
callbacks) are the next slice.

## Going live (testnet)

1. Run `ravend` with `-server=1 -testnet=1`, let it sync.
2. Fill in `.env`: `MOCK_RVN=false`, `RVN_RPC_URL`, `RVN_RPC_USER`, `RVN_RPC_PASS`.
3. Restart. The same API now drives real `issue` / `transfer` RPCs.
4. Verify RPC shapes against your node: `ravend help issue` — parameter order matters
   and varies slightly across versions; see `src/rvn/client.ts`.

## What's stubbed

- **Persistence** — policies, intents, ledger and audit are in-memory.
- **Approvals channel** — approvals are an HTTP call plus Telegram hold
  notifications; inbound Approve/Deny buttons are the next slice.
- **Reissuance / unique assets** — `issueunique` and sub-assets aren't exposed yet.
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
