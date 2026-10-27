# rvn-agent-api — Build Roadmap

Prioritized backlog. The daily build session takes the top unchecked item (or the
smallest shippable slice of it), implements it, keeps `pnpm build` + `pnpm demo` green,
and logs the result in CHANGELOG.md.

## Backlog

- [x] 2026-10-22 — v0.7.0 Postgres persistence (item complete): new
  `src/store/` seam — `Store` interface (policies / intents+decisions /
  async issue ledger / hash-chained audit) with two backends. `PostgresStore`
  (`pg` pool) persists everything to Postgres: JSONB tables for policies,
  intents and decisions, a `ledger_spend` table with in-SQL rolling-window
  sums (bigint quantities as decimal strings, never floats), and
  `audit_entries` where appends are serialized with a
  `pg_advisory_xact_lock` so the hash chain can never fork; audit details are
  canonicalized (recursively key-sorted) and stored as TEXT for a byte-exact
  round-trip (JSONB reorders keys, which broke verification in testing). Both backends
  build entries through the shared `makeChainedEntry`/`verifyChain` helpers
  so chains are byte-identical. `storeFromEnv()` picks Postgres when
  `RVN_DATABASE_URL` (or `DATABASE_URL`) is set and reachable — applying
  `src/store/schema.sql` idempotently at startup — and falls back to the
  in-memory store with a loud log line on any failure, so the API always
  boots; default policy is seeded when absent. `IssueLedger` and
  `evaluateIntent` are now async. `/v1/health` reports `store:
  'postgres'|'memory'`. New `docker-compose.yml` (postgres:16-alpine, schema
  mounted into initdb.d). New `pnpm test:store` (`demo/store-test.ts`, 18
  checks: the full suite against the memory store, the same suite against a
  live Postgres when `TEST_DATABASE_URL` is set, plus fallback-on-unreachable
  behavior) — all green. `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`, `pnpm test:simulate`
  still green. Package is now `"type": "module"` (imports already used ESM
  `.js` specifiers). Follow-ups: schema migrations (today it's
  CREATE-IF-NOT-EXISTS only — no alter path), audit-table partitioning as the
  chain grows.
- [x] 2026-10-21 — v0.6.0 Simulation endpoint (item complete): new
  `POST /v1/intents/simulate` returns the policy decision an issue/transfer
  WOULD get — ALLOW / REQUIRE_APPROVAL / DENY with reason codes — without
  persisting the intent, recording issue spend, touching the audit chain,
  notifying approvers, or executing anything. Simulated decision ids are
  `sim-<uuid>` namespaced and approving/denying one 404s. Field aliases
  (`name`/`toAddress`) accepted; invalid bodies (bad op, missing fields,
  non-integer qty) return 400. New `simulate_intent` MCP tool (keeps the
  "MCP covers every REST route" invariant). Verified with
  `demo/simulate-test.ts` (33 checks: decisions per path, zero-side-effect
  proofs — audit seq unchanged, pending list empty, budget accounting reads
  but never writes — 404 on approve/deny of simulated ids, 400 cases) and a
  new MCP smoke section (3 checks). `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback` all still green.
- [x] **Reissuance + unique assets** — expose `reissue`, `issueunique` and sub-asset
  issuance through the same policy-gated flow (item complete).
  - [x] 2026-10-23 — v0.8.0 reissue (slice 1, item partial): `reissueAsset` on the
    node seam (mock + real `reissue` RPC client), `POST /v1/assets/reissue` and the
    `reissue_asset` MCP tool, new `reissue_asset` intent kind evaluated exactly like
    an issue (per-op cap, shared 24h issue budget, approval threshold, allowlist,
    name pattern — ledger records reissues against the budget). Extra params
    (`reissuable`, `newUnits` 0–8, `newIpfsHash`, positional so `newIpfsHash`
    requires `newUnits`) are captured on `RvnIntent.execParams` and replayed at
    approval time — this also fixed the issue route silently dropping
    `units`/`reissuable`/`ipfsHash` for held intents (plus JSON-boolean
    `reissuable` parsing). `simulate` accepts `op: 'reissue'`. Verified with new
    `pnpm test:reissue` (51 checks), 5 new MCP smoke checks; demo, approvals,
    telegram-callback, simulate, store suites still green.
  - [x] 2026-10-24 — v0.9.0 sub-asset issuance (slice 2, item partial):
    `issueSubAsset` on the node seam (mock enforces parent-exists + per-segment
    shape; real client delegates to ravend's `issue` RPC, which treats a slash
    name as a sub-asset), `POST /v1/assets/issue-subasset` and the
    `issue_subasset` MCP tool, new `issue_subasset` intent kind evaluated
    exactly like an issue (per-op cap, shared 24h issue budget, approval
    threshold, allowlist) except the asset-name pattern is applied to every
    slash-separated segment, and nested sub-assets (`PARENT/CHILD/GRAND`)
    work when the immediate parent exists. Extra params (`units`/`reissuable`/
    `ipfsHash`) captured on `execParams` and replayed at approval time.
    `simulate` accepts `op: 'subasset'`. Verified with new
    `pnpm test:subasset` (55 checks), 5 new MCP smoke checks; demo, approvals,
    telegram-callback, simulate, reissue, store suites still green.
  - [x] 2026-10-25 — v0.10.0 unique assets (slice 3, item complete):
    `issueUniqueAsset` on the node seam (mock enforces root-exists,
    exactly-one-`#`, and tag shape; real client calls ravend's
    `issueunique` with `[root, [tag], ipfsHash, toAddress, '']`),
    `POST /v1/assets/issue-unique` and the `issue_unique` MCP tool, new
    `issue_unique` intent kind evaluated exactly like an issue (per-op cap,
    shared 24h issue budget with each unique counting 1, approval threshold,
    allowlist) except the asset-name pattern is applied to every
    slash-separated segment of the root and the tag is checked separately
    (1–30 chars, wider charset). Unique assets are singletons: qty fixed
    at 1 (route 400s anything else, omitted qty defaults to 1), amount 1,
    units 0, never reissuable — and reissuing one is denied at the policy
    layer since `#` is not in the reissue name pattern. `simulate`
    accepts `op: 'unique'` (qty normalized to 1). Verified with new
    `pnpm test:unique` (58 checks), 5 new MCP smoke checks; demo, approvals,
    telegram-callback, simulate, reissue, subasset, store suites still green.
- [x] 2026-10-26 — v0.11.0 Policy presets gallery (item complete):
  `POLICY_PRESETS` in `src/policy/presets.ts` — conservative (tight caps,
  low thresholds, empty allowlist), balanced (the Phase-0 default), and
  permissive (high caps/thresholds, wildcard allowlist, 1h TTL) — plus
  `applyPreset()` which merges per-agent overrides onto a preset and
  rejects unknown presets/fields and malformed values (non-integer qty,
  negative qty, non-positive TTL, bad regex, non-array destinations) before
  anything is stored. `GET /v1/policies/presets` lists the gallery;
  `POST /v1/policies/:agentId/preset` applies a preset wholesale (same
  replace semantics as PUT, audited as POLICY_REPLACED naming the preset).
  New `list_presets` / `apply_preset` MCP tools keep the "MCP covers every
  REST route" invariant. Verified with new `pnpm test:presets`
  (`demo/preset-test.ts`, 32 checks) and 4 new MCP smoke checks; demo,
  approvals, telegram-callback, simulate, reissue, subasset, unique, store
  suites still green.
- [x] 2026-10-27 — v0.12.0 Anomaly detection (item complete): new
  `src/policy/anomaly.ts` — pure `detectAnomalies()` with two signals.
  `QTY_OUTLIER`: qty more than 10x the median of the agent's prior
  same-kind intents (at least 3 samples; fewer means no baseline, never a
  flag). `FIRST_SEEN_DESTINATION_BURST`: a destination never seen in the
  agent's history, arriving while the agent submitted 3+ intents in the
  last hour. Either signal routes a would-be-ALLOW intent to
  REQUIRE_APPROVAL with reason code `ANOMALY_SUSPECTED` — a hold, never a
  deny; hard denies still win, and already-held intents keep their original
  reason. `IntentStore.history(agentId)` (memory + Postgres, newest first)
  supplies the baseline; the server fetches it before storing the intent
  under evaluation, and simulate reads it without writing, so simulations
  never pollute the baseline. Verified with new `pnpm test:anomaly`
  (`demo/anomaly-test.ts`, 43 checks) and history checks in
  `pnpm test:store`; demo, approvals, telegram-callback, simulate,
  reissue, subasset, unique, presets, mcp-smoke still green. Follow-ups:
  anomaly thresholds (multiplier, burst window/count) as policy fields
  instead of constants; an anomaly-stats endpoint.
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
