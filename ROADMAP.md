# rvn-agent-api — Build Roadmap

Prioritized backlog. The daily build session takes the top unchecked item (or the
smallest shippable slice of it), implements it, keeps `pnpm build` + `pnpm demo` green,
and logs the result in CHANGELOG.md.

## Backlog

- [ ] **Postgres persistence** — move policies, intents, ledger and audit from memory
  to Postgres (docker-compose); keep in-memory as fallback when DB is unreachable.
- [ ] **Simulation endpoint** — `POST /v1/intents/simulate` returns the policy decision
  without executing, recording spend, or touching the audit chain.
- [ ] **Reissuance + unique assets** — expose `reissue`, `issueunique` and sub-asset
  issuance through the same policy-gated flow.
- [ ] **Policy presets gallery** — conservative / balanced / permissive presets plus
  per-agent overrides; `GET /v1/policies/presets`.
- [ ] **Anomaly detection** — flag statistically unusual intents (qty outlier for the
  agent, first-seen destination velocity) with a new `ANOMALY_SUSPECTED` reason code
  that routes to REQUIRE_APPROVAL.
- [ ] **LangChain tool adapter** — wrap the REST API as LangChain tools for Python agents.
- [ ] **Webhooks** — POST decision/execution events to a configured URL.
- [ ] **Rate limiting** — per-agent operation limits (token bucket) as a policy dimension.

## Done

- [x] 2026-10-20 — v0.5.0 Telegram approvals (slice 2, item complete): hold
  notifications now carry Approve / Deny inline buttons; taps come back
  through `POST /v1/telegram/webhook` as callback queries and resolve the
  intent through the same path as the HTTP approve/deny routes (answerCallbackQuery
  toast + the hold message edited in place with the outcome). New
  `POST /v1/intents/:id/deny` endpoint (also exposed as the `deny_intent` MCP
  tool) — denied intents are marked `DENIED_BY_OWNER` and audited as `DENIAL`.
  Per-agent chat routing via `TELEGRAM_APPROVAL_CHAT_IDS_JSON` (agentId -> chat
  id), with `TELEGRAM_APPROVAL_CHAT_ID` as the default. Webhook secret check
  via `TELEGRAM_WEBHOOK_SECRET` (`X-Telegram-Bot-Api-Secret-Token` header);
  `TELEGRAM_API_BASE_URL` overridable for tests. `/v1/health` reports
  `telegramWebhookSecretConfigured` and `perAgentChatRoutes`. Verified with
  `demo/telegram-callback-test.ts` (45 checks: parsing, keyboard shape,
  routing, deny/approve button flows, secret enforcement, conflict handling —
  all against a stub Bot API, nothing touches the network). `pnpm demo` and
  `pnpm mcp-smoke` still green (smoke grew a deny-flow section, 33 checks).

- [x] 2026-10-19 — v0.3.0 MCP server (slice 2, item complete): added
  `approve_intent`, `pending_intents`, `get_policy`, `set_policy` tools; MCP
  surface now covers every REST route. Fixed an API bug found while writing the
  smoke test: re-approving an already-approved intent re-executed it — the
  decision is now marked resolved after approval, so a second approve returns
  409. `demo/mcp-smoke.ts` grew 16 checks (30 total, all green).
- [x] 2026-10-19 — v0.2.0 MCP server (slice 1): stdio MCP transport (`pnpm mcp`)
  exposing `issue_asset` / `transfer_asset` / `list_assets` / `get_audit` as
  tools, proxying to the REST API so the policy engine stays the single
  enforcement point. No SDK dependency (hand-rolled JSON-RPC 2.0 stdio).
  Verified with `demo/mcp-smoke.ts` (14 checks green); `pnpm demo` still green.
- [x] 2026-10-18 — Phase 0 spike: policy-gated issue/transfer, mock + real node,
  hash-chained audit, demo loop green.
