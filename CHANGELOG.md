# Changelog

## 2026-10-27 — v0.12.0 (Anomaly detection, item complete)

- New `src/policy/anomaly.ts`: pure `detectAnomalies(intent, history,
  nowMs)` returning `QTY_OUTLIER` / `FIRST_SEEN_DESTINATION_BURST`
  signals. Qty outlier: the intent's qty exceeds 10x the median qty of
  the agent's prior intents of the same kind, requiring at least 3
  samples (median, not mean, so one past whale can't drag the baseline;
  even counts use the lower median, the conservative side for a
  hold-not-deny signal). First-seen burst: the destination never appears
  in the agent's history and the agent submitted 3+ intents in the last
  hour — a new destination alone is not suspicious (the allowlist gate
  already handles it); a new destination mid-burst is what looks like a
  compromised agent spraying funds somewhere new. History entries with
  unparseable or non-positive qtys are ignored; the intent under
  evaluation is excluded by id, so approval-time re-evaluation can't
  flag itself.
- `evaluateIntent` takes an optional `history` argument (default `[]`,
  so existing callers are unaffected) and gains a Stage-2b anomaly gate:
  after the hard denies and the existing approval routing, a
  would-be-ALLOW intent with any anomaly signal becomes
  REQUIRE_APPROVAL with reason code `ANOMALY_SUSPECTED`. Hard denies
  still win, and intents already held for an unknown destination or an
  above-threshold qty keep their original reason — the gate exists to
  catch the case the other gates miss, an intent that looks policy-clean
  but statistically strange. An anomalous hold approves through the
  normal path like any other hold.
- New `IntentStore.history(agentId, limit?)` (newest first, default 200):
  in-memory filter + sort, Postgres via
  `intent->>'agentId'` with a `(intent->>'requestedAtMs')::bigint`
  ordering. The server fetches history before storing the intent under
  evaluation in `submit`, at approval-time re-evaluation in
  `resolveApproval`, and in `simulate` — where the read is strictly
  read-only, so a simulation runs the same anomaly gate as a real submit
  but never enters the baseline.
- New `pnpm test:anomaly` (`demo/anomaly-test.ts`): 43 checks — qty
  outlier holds with `ANOMALY_SUSPECTED` and approves normally; exactly
  10x the median ALLOWs (strictly-greater rule); a fresh agent's first
  issue ALLOWs (no baseline, no false positive); first-seen destination
  inside a burst holds and approves, while the same issue with only 2
  recent intents ALLOWs; an over-cap outlier DENYs with
  `ISSUE_CAP_EXCEEDED` and no `ANOMALY_SUSPECTED`; simulate runs the
  gate with zero side effects (audit seq unchanged, pending empty, later
  real issue unaffected); audit chain valid — all green.
  `demo/store-test.ts` gained history checks (newest-first order,
  per-agent filtering, limit) run against both backends.
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:store` still green. No new REST route
  or MCP tool (the gate rides the existing evaluation path), so the MCP
  surface is unchanged. `initialize` now reports server version 0.12.0.
- Environment note: no `pnpm`
  binary on this VM — verification ran the direct equivalents
  (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`); `package.json` scripts
  are unchanged in content apart from the new `test:anomaly` script.
- The anomaly detection roadmap item is complete; the next top item is
  the LangChain tool adapter.

## 2026-10-26 — v0.11.0 (Policy presets gallery, item complete)

- New `POLICY_PRESETS` in `src/policy/presets.ts`: three named starting
  policies — `conservative` (per-issue cap 10,000, approval above 1,000,
  24h budget 50,000, empty allowlist, 60s TTL), `balanced` (the Phase-0
  default: cap 100,000, approval above 10,000, budget 500,000, 60s TTL),
  and `permissive` (cap 10,000,000, approval above 1,000,000, budget
  100,000,000, wildcard `['*']` allowlist, 3600s TTL) — each with a
  description and a full version:1 policy document.
- New `applyPreset(presetId, agentId, overrides)` helper: merges per-agent
  overrides (caps, budgets, thresholds, destination lists, asset-name
  pattern, TTL) onto the preset and validates before anything is stored —
  unknown preset, unknown override field, non-integer/negative qty,
  non-positive TTL, invalid regex, or non-array destination list all throw
  (surfaced as 400), so a typo can never silently half-apply. `version` and
  `agentId` are not overridable; the applied policy always carries the
  route's agentId.
- New `GET /v1/policies/presets` (registered ahead of the parametric policy
  route so `presets` never resolves as an agent id) and
  `POST /v1/policies/:agentId/preset` (body: `{ preset, overrides? }`) —
  same replace semantics as `PUT /v1/policies/:agentId`, audited as
  `POLICY_REPLACED` with the preset id and the overridden field names.
- New `list_presets` / `apply_preset` MCP tools — the MCP surface stays a
  complete superset of the REST routes. `initialize` now reports server
  version 0.11.0.
- New `pnpm test:presets` (`demo/preset-test.ts`): 32 checks — gallery
  listing (3 presets, order, descriptions, version:1/`*` documents, cap
  ordering, permissive wildcard); conservative apply reads back and denies
  an over-cap issue; balanced apply with overrides merges (overridden
  threshold gates, untouched cap/budget stay) and allowlisted/below-threshold
  issues ALLOW; permissive ALLOWs a mid-size issue to an unknown
  destination; all nine rejection paths (unknown preset/field, non-numeric
  and negative qty, non-positive TTL, bad regex, non-array destinations,
  array overrides, missing preset) return 400 and leave the agent on the
  default policy; an assetNamePattern override is enforced via simulate;
  audit chain valid — all green. `demo/mcp-smoke.ts` gained a presets
  section (4 checks: list + apply + gating + unknown-preset error).
  `pnpm demo`, `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`, `pnpm test:subasset`,
  `pnpm test:unique`, `pnpm test:store` still green.
- Environment note: no `pnpm`
  binary on this VM — verification ran the direct equivalents
  (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`); `package.json` scripts
  are unchanged in content.
- The policy presets gallery roadmap item is complete; the next top item is
  anomaly detection.

## 2026-10-25 — v0.10.0 (Unique assets, slice 3 — reissuance item complete)

- New `issueUniqueAsset` on the `RvnNode` seam: `MockRvnNode` validates
  the `ROOT#TAG` shape (exactly one `#`, root exists, tag 1–30 chars of
  letters/digits/`.`/`_`/`-`), and creates a singleton — amount `1`,
  units 0, reissuable `false`, with the destination credited 1;
  `RvnRpcClient` calls ravend's `issueunique` RPC
  (`issueunique "root_name" ["tag"] "ipfs_hash" "to_address"
  "change_address"` — one tag per API call, per the RPC's tag-list
  parameter). The API uppercases asset names before they reach the node,
  as with every other kind, so tags are case-insensitive here even though
  ravend itself allows lowercase tags.
- New `POST /v1/assets/issue-unique` (body: `name` e.g. `MYCOIN#SERIAL001`,
  `toAddress`, `agentId?`, optional `ipfsHash?`, optional `qty` which must
  be `'1'` when given and defaults to `1`; 400 when the name has no `#` or
  the qty is not 1) and the `issue_unique` MCP tool — the MCP surface stays
  a complete superset of the REST routes.
- New `issue_unique` intent kind: the policy engine treats a unique asset
  exactly like an issue — same per-op cap, same shared 24h issue budget
  (each unique counts 1), same approval threshold, destination allowlist —
  with the `ISSUE_*` reason codes, except the asset-name pattern is
  applied to every slash-separated segment of the root (so uniques under
  a sub-asset root, e.g. `ART/DAVINCI#MONALISA`, work) and the tag is
  checked separately against its wider charset. `createsSupply` now covers
  all four supply-creating kinds.
- Extra param `ipfsHash` rides `RvnIntent.execParams` and is replayed at
  approval-time execution; approval notifications label the op `UNIQUE`.
  Reissuing a unique asset is denied at the policy layer (the reissue
  name pattern contains no `#`) — and would fail at the node too, since
  uniques are created non-reissuable.
- `POST /v1/intents/simulate` accepts `op: 'unique'` (qty normalized to
  `'1'`; any other qty is a 400); the node-level root-exists check is not
  run on simulation, same as reissue/sub-asset.
- New `pnpm test:unique` (`demo/unique-test.ts`): 58 checks — plain,
  ipfs, and sub-asset-root issuance; singleton properties (amount 1,
  units 0, never reissuable, root unchanged); unknown root and duplicate
  name -> 502; no-hash name and qty 2 -> 400; two-hash, short-root, and
  empty-tag names -> 403 `ASSET_NAME_REJECTED`; reissue attempt -> 403;
  hold -> approve -> created (ipfsHash replayed); deny flow; shared-budget
  accounting (each unique counts 1); simulate zero-side-effect proofs;
  audit chain valid — all green. `demo/mcp-smoke.ts` gained a unique
  section (5 checks: ALLOW + singleton properties + unknown-root error +
  simulate op:unique). `pnpm demo`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:store` still green.
- `initialize` now reports server version 0.10.0. Environment note: no `pnpm`
  binary on this VM — verification ran the direct equivalents
  (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`); `package.json` scripts
  are unchanged in content.
- The reissuance + unique assets roadmap item is complete; the next top
  item is the policy presets gallery.

## 2026-10-24 — v0.9.0 (Sub-asset issuance, slice 2 of the reissuance item)

- New `issueSubAsset` on the `RvnNode` seam: `MockRvnNode` validates the
  slash name (every segment 1–30 chars of the asset alphabet), requires the
  immediate parent asset to exist, and creates the sub-asset with its own
  supply/units/reissuable/ipfsHash; `RvnRpcClient` delegates to ravend's
  `issue` RPC, which natively issues sub-assets from a slash name (ravend
  itself enforces parent existence and ownership).
- New `POST /v1/assets/issue-subasset` (body: `name` e.g. `PARENT/SUB`, `qty`,
  `toAddress`, `agentId?`, `units?`, `reissuable?`, `ipfsHash?`; 400 when the
  name has no `/`) and the `issue_subasset` MCP tool — the MCP surface stays
  a complete superset of the REST routes.
- New `issue_subasset` intent kind: the policy engine treats a sub-asset
  exactly like an issue — same per-op cap, same shared 24h issue budget
  (sub-asset spend records against it), same approval threshold, destination
  allowlist — with the `ISSUE_*` reason codes, except the asset-name pattern
  is applied to every slash-separated segment (`nameMatchesPattern` in
  `src/policy/evaluate.ts`; a bare parent or a too-short segment DENYs with
  `ASSET_NAME_REJECTED`). Nested sub-assets (`PARENT/CHILD/GRAND`) work when
  the immediate parent exists. `createsSupply` now covers all three
  supply-creating kinds.
- Extra params ride `RvnIntent.execParams` (as with issue/reissue) and are
  replayed at approval-time execution; approval notifications label the op
  `SUBASSET`.
- `POST /v1/intents/simulate` accepts `op: 'subasset'`; the node-level
  parent-exists check is not run on simulation, same as reissue.
- New `pnpm test:subasset` (`demo/subasset-test.ts`): 55 checks — plain,
  extras, and nested issuance; unknown parent and duplicate name -> 502;
  no-slash name -> 400; short segment -> 403 `ASSET_NAME_REJECTED`; over-cap
  and over-budget denies; hold -> approve -> created (execParams replayed);
  deny flow; simulate zero-side-effect proofs; audit chain valid — all
  green. `demo/mcp-smoke.ts` gained a sub-asset section (5 checks: ALLOW +
  creation + units + unknown-parent error + simulate op:subasset). `pnpm demo`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:store` still green.
- `initialize` now reports server version 0.9.0. Environment note: no `pnpm`
  binary on this VM — verification ran the direct equivalents
  (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`); `package.json` scripts
  are unchanged in content.
- Remainder of the roadmap item: `issueunique` only.

## 2026-10-23 — v0.8.0 (Reissue, slice 1 of the reissuance item)

- New `reissueAsset` on the `RvnNode` seam: `MockRvnNode` validates the asset
  exists and is reissuable, grows the supply, credits the destination, and
  applies `newUnits` (0–8) / `newIpfsHash` / `reissuable` flag flips;
  `RvnRpcClient` calls the real `reissue` RPC
  (`reissue "asset_name" qty "to_address" change_address reissuable new_units
  new_ipfs_hash` — params are positional, so `newIpfsHash` is only sent when
  `newUnits` is set).
- New `POST /v1/assets/reissue` (body: `name`, `qty`, `toAddress`, `agentId?`,
  `reissuable?`, `newUnits?`, `newIpfsHash?`; 400 on missing fields, bad
  `newUnits`, or `newIpfsHash` without `newUnits`) and the `reissue_asset` MCP
  tool — the MCP surface stays a complete superset of the REST routes.
- New `reissue_asset` intent kind: the policy engine treats a reissue exactly
  like an issue — same per-op cap, same shared 24h issue budget (reissues
  record against it), same approval threshold, destination allowlist, and
  asset-name pattern — with the `ISSUE_*` reason codes. `createsSupply` is
  exported from `src/policy/evaluate.ts` and reused by the server for ledger
  accounting.
- New optional `RvnIntent.execParams`: extra node params captured at submit
  time and replayed at approval-time execution, so held intents no longer lose
  them. This fixed a real wart in the same edit: the issue route silently
  dropped `units`/`reissuable`/`ipfsHash` for intents that went through
  REQUIRE_APPROVAL (they only applied to immediate ALLOWs). Both the issue
  and reissue routes now funnel through a shared `executeIntent` dispatcher.
  Also fixed `reissuable` parsing: a JSON boolean `false` was read as
  truthy (only the string `'false'` worked).
- `POST /v1/intents/simulate` accepts `op: 'reissue'`; approval-notification
  and Telegram-resolved messages label the op `REISSUE`.
- New `pnpm test:reissue` (`demo/reissue-test.ts`): 51 checks — supply growth,
  extras (units/ipfs) applied, over-cap and over-budget denies, unknown and
  non-reissuable assets → 502 with execution-failure audit, hold → approve
  → txid (execParams replayed), deny flow, 400 cases, simulate zero-side-effect
  proofs, audit chain valid — all green. `demo/mcp-smoke.ts` gained a reissue
  section (5 checks: ALLOW + supply growth + over-cap isError + simulate
  op:reissue). `pnpm demo`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`, `pnpm test:store`
  still green.
- `initialize` now reports server version 0.8.0. Environment note: no `pnpm`
  binary on this VM — verification ran the direct equivalents
  (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`); `package.json` scripts
  are unchanged in content.
- Remainder of the roadmap item: `issueunique` + sub-asset issuance.

## 2026-10-22 — v0.7.0 (Postgres persistence)

- New persistence seam (`src/store/`): a `Store` interface covering policies,
  intents + decisions, the issue ledger, and the hash-chained audit, with two
  backends. `PostgresStore` (new `pg` dependency) persists everything to
  Postgres: JSONB tables for policies/intents/decisions, a `ledger_spend`
  table with rolling-window sums computed in SQL (quantities stay decimal
  strings, never floats), and `audit_entries` whose appends are serialized
  with `pg_advisory_xact_lock` so the hash chain can never fork. Audit details
  are canonicalized (recursively key-sorted) and stored as TEXT so the hashed
  bytes round-trip byte-exact — JSONB reorders keys, which broke verification
  in testing. Both
  backends build entries through shared `makeChainedEntry`/`verifyChain`
  helpers in `src/audit.ts`, so chains are byte-identical.
- `storeFromEnv()` selects the backend: `RVN_DATABASE_URL` (or
  `DATABASE_URL`) set and reachable -> Postgres (applies
  `src/store/schema.sql` idempotently at connect); anything else -> the
  in-memory store with a loud log line, so the API always boots. Default
  policy is seeded when absent. `/v1/health` now reports
  `store: 'postgres'|'memory'`.
- `IssueLedger` and `evaluateIntent` are async (the Postgres ledger round-trips
  the DB); server routes updated accordingly. Package is now
  `"type": "module"` (imports already used ESM `.js` specifiers).
- New `docker-compose.yml`: `postgres:16-alpine` with the schema mounted into
  `/docker-entrypoint-initdb.d`, so `docker compose up -d` plus
  `RVN_DATABASE_URL=postgres://rvn:rvn@localhost:5432/rvn_agent_api` gives a
  persisted API.
- New `pnpm test:store` (`demo/store-test.ts`, 18 checks): the full suite
  (policy/intent/decision round-trips, pending listing + expiry, ledger
  window accounting, audit chain + tamper detection) against the memory
  store, the same suite against a live Postgres when `TEST_DATABASE_URL` is
  set, and fallback-on-unreachable-DB behavior — all green.
- `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate` still green.
- Environment note: this VM's filesystem rejects pnpm's file-ownership step,
  so `pnpm-lock.yaml` could not be regenerated here — `pg`/`@types/pg` are
  declared in `package.json` and installed in `node_modules`; run
  `pnpm install` on a normal filesystem to refresh the lockfile.
- The Postgres persistence item in ROADMAP.md is complete; known follow-ups:
  schema migrations (currently CREATE-IF-NOT-EXISTS only) and audit-table
  partitioning as the chain grows.

## 2026-10-21 — v0.6.0 (Simulation endpoint)

- New `POST /v1/intents/simulate`: dry-runs an issue or transfer through the
  policy engine and returns the decision it WOULD get (ALLOW /
  REQUIRE_APPROVAL / DENY with reason codes) — without persisting the intent,
  recording issue spend, appending to the audit chain, notifying approvers,
  or executing anything. Body: `{ op: 'issue'|'transfer', agentId?, assetName
  (or name), qty, destination (or toAddress) }`; invalid bodies return 400.
  Simulated decision ids are `sim-<uuid>` namespaced and are not
  approvable/deniable (404 on both), so a dry run can never be acted on.
- New `simulate_intent` MCP tool proxying the endpoint — the MCP surface
  stays a complete superset of the REST routes (transport only, same as
  everything else). `initialize` now reports server version 0.6.0.
- New `pnpm test:simulate` (`demo/simulate-test.ts`, self-booting API): 33
  checks — decision per policy path, zero-side-effect proofs (audit seq
  unchanged across sims, pending list empty, budget accounting reads the
  real ledger but a sim never consumes it, simulated hold triggers no
  notification entries), 404 on approve/deny of simulated ids, 400 on bad op,
  missing fields, and non-integer qty — all green.
- `demo/mcp-smoke.ts` gained a simulate section (3 checks: ALLOW via MCP,
  DENY surfaces as `isError`, no audit entries written); 38 checks total,
  all green. `pnpm demo`, `pnpm test:approvals`, and
  `pnpm test:telegram-callback` still green.
- The Simulation endpoint item in ROADMAP.md is complete; Postgres
  persistence is the next top item.

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
