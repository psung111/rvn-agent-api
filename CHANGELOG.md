# Changelog

## 2026-10-20 — v0.5.0 (Telegram approval buttons + per-agent routing, item complete)

- Every hold notification now carries Approve / Deny inline buttons
  (`src/approvals/callbacks.ts`). Button taps arrive as callback queries on
  the new `POST /v1/telegram/webhook` endpoint and resolve through the same
  `resolveApproval` path as the HTTP routes: the owner gets an
  answerCallbackQuery toast and the hold message is edited in place with the
  outcome (approver label + txid, or the denial).
- New `POST /v1/intents/:id/deny` route and `deny_intent` MCP tool. Denied
  intents get reason code `DENIED_BY_OWNER`, a `DENIAL` audit entry, and a
  subsequent approve returns 409. The Telegram item in ROADMAP.md is complete.
- Per-agent chat routing: `TELEGRAM_APPROVAL_CHAT_IDS_JSON` maps agentId ->
  chat id; unset agents fall back to `TELEGRAM_APPROVAL_CHAT_ID`. Malformed
  JSON degrades to no overrides rather than crashing startup.
- Webhook authenticity: `TELEGRAM_WEBHOOK_SECRET` enables the
  `X-Telegram-Bot-Api-Secret-Token` header check (403 on mismatch); without
  it the route still works for local dev. The webhook always answers 200 so
  Telegram never retries; conflicts (409/404/410) surface in the toast text.
- `TELEGRAM_API_BASE_URL` overrides the Bot API base (tests point it at a
  local stub); `/v1/health` reports `telegramWebhookSecretConfigured` and
  `perAgentChatRoutes`.
- New `pnpm test:telegram-callback` (`demo/telegram-callback-test.ts`): 45
  checks — callback-data round-trip and rejection of malformed data, keyboard
  shape, routing unit tests, and an integration run of the real API behind a
  stub Bot API covering deny and approve button flows, secret enforcement,
  re-approval conflict, unknown intent, and the HTTP deny endpoint.
- `pnpm demo` and `pnpm mcp-smoke` still green; smoke gained a deny-flow
  section (33 checks total).

## 2026-10-19 — v0.4.0 (Telegram approval notifications, slice 1)

- New approval-notification layer (`src/approvals/notifier.ts`): every
  REQUIRE_APPROVAL intent now fans out to a pluggable `ApprovalNotifier`.
  `TelegramApprovalNotifier` posts a hold message to the owner's bot via
  Telegram `sendMessage` — intent id, op, asset, qty, destination, reason
  codes, expiry, and a copy-paste approve `curl` — with one retry on failure.
- Notification failures never fail the hold: they are audited as
  `APPROVAL_NOTIFICATION_FAILED` and the intent still waits for
  `POST /v1/intents/:id/approve` (202). Successful/dismissed sends are audited
  as `APPROVAL_NOTIFICATION`; both are new `AuditKind`s.
- Config via `TELEGRAM_APPROVAL_BOT_TOKEN` + `TELEGRAM_APPROVAL_CHAT_ID`;
  unset -> disabled NoopNotifier (demo default). The token is kept out of logs,
  audit entries, and message text. `/v1/health` reports
  `approvals.telegramConfigured`.
- New `pnpm test:approvals` (`demo/approval-notify-test.ts`): 17 checks covering
  env parsing, message format/token hygiene, happy path, retry-then-success,
  and give-up-after-two-failures — all green. `pnpm demo` and `pnpm mcp-smoke`
  still green.
- Remainder of the Telegram item: per-agent routing, inline Approve/Deny
  buttons via inbound Telegram callback queries hitting
  `/v1/intents/:id/approve`.

## 2026-10-19 — v0.3.0 (MCP server complete)

- MCP server now exposes the full API: new `approve_intent` (approves a held
  intent; 404/409/410 surface as MCP errors), `pending_intents`, `get_policy`,
  and `set_policy` (client should `get_policy` first and edit the returned
  document; `agentId` is forced to match the route). The MCP transport is no
  longer a subset — every REST route is callable as a tool, still with the REST
  API as the single enforcement point.
- Bug fix found by the new smoke checks: approving an already-approved intent
  re-executed it on the node. `POST /v1/intents/:id/approve` now marks the
  decision resolved after execution (reason code `APPROVED`), so a second
  approve returns 409; a re-evaluation DENY also persists on the decision.
- `demo/mcp-smoke.ts`: 16 new checks (30 total) — full approval flow through
  MCP (issue → held transfer → pending → approve → gone from pending),
  re-approve and unknown-intent error paths, and policy get/set round-trip
  including rejection of `version: 2`. `pnpm mcp-smoke` all green; `pnpm demo`
  still green.

## 2026-10-19 — v0.2.0 (MCP server, slice 1)

- New `pnpm mcp` stdio MCP server (`src/mcp.ts`) exposing `issue_asset`,
  `transfer_asset`, `list_assets`, `get_audit` as MCP tools. It proxies to the
  REST API, so every tool call runs through the policy engine and hash-chained
  audit exactly like a REST call. Zero new dependencies (JSON-RPC 2.0 over
  line-delimited stdio); wire into a client config with `command: pnpm`,
  `args: [--dir, <repo>, mcp]` and optional `RVN_API_URL`.
- DENY decisions from issue/transfer tools surface as MCP errors (`isError`);
  REQUIRE_APPROVAL decisions return the held intent id for a later approve.
- New `pnpm mcp-smoke` (`demo/mcp-smoke.ts`): handshake, tools/list, list_assets,
  get_audit chain validity, unknown-tool and unknown-method handling — 14 checks.
- Remainder of the MCP roadmap item: `approve_intent`, `pending_intents`, and
  policy-management tools (later slice).

- Agent-facing REST API for Ravencoin assets: issue / transfer / list / wallet provisioning.
- Policy engine: ALLOW / REQUIRE_APPROVAL / DENY with reason codes, per-op caps,
  24h issue budgets, destination allowlists, asset-name validation, decision TTL
  with re-evaluation at approval time.
- Node backends behind one interface: in-memory mock (default) + real `ravend`
  JSON-RPC client (testnet-ready).
- Hash-chained audit log with `/v1/audit` verification.
- Policy management: `GET` / `PUT /v1/policies/:agentId`.
- Node execution failures return 502 (not 500) and are audited as EXECUTION_FAILED.
- Demo walks the full loop; `pnpm build` clean.
