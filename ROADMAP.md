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
- [x] **LangChain tool adapter** — wrap the REST API as LangChain tools for Python agents.
  - [x] 2026-10-28 — v0.13.0 LangChain adapter (slice 1, item partial):
    new `langchain_rvn/` Python package. `client.py` is a stdlib-only
    REST client covering every route (issue / reissue / sub-asset /
    unique / transfer / list / get / simulate / approve / deny / pending
    / policy / presets / audit / wallet); quantities stay base-unit
    decimal strings, and a DENY decision returns its payload on 403
    instead of raising (other 4xx/5xx raise `RvnApiError`).
    `tools.py` builds 17 LangChain `StructuredTool`s on that client —
    one per route, results as JSON strings, holds returned as intent ids
    (never errors), API rejections as `{"error", "status"}` objects —
    so the policy engine stays the single enforcement point exactly as
    with the MCP server. Importing the package never requires
    langchain-core; only `get_tools()` does. Verified with new
    `langchain_rvn/test_adapter.py` (27 checks, self-booting API on the
    mock node: client ALLOW/DENY/hold flows, tool ALLOW/DENY/hold →
    approve → executed, hold → deny, 409 re-approve, 404 unknown intent,
    simulate zero-side-effect proof, audit chain valid) plus
    `pnpm build`, `pnpm demo`, `pnpm mcp-smoke` and every `test:*`
    suite still green.
  - [x] 2026-10-29 — v0.14.0 agent-executor example + PyPI packaging
    (slice 2, item complete): `langchain_rvn/examples/agent_executor.py`
    runs a complete tool-calling loop (allowlist the destination, then
    simulate → issue → audit) against a local mock-node API, using
    langchain-core's deterministic `GenericFakeChatModel` in place of a
    real chat model — no LLM key, no network beyond localhost, no real
    funds — with a hold path that reports the intent id and stops
    instead of auto-approving; swapping in a real model bound to the
    tools turns the same loop into a live agent. Packaging fixed for
    real: the v0.13.0 pyproject could not build at all (`package
    directory 'langchain_rvn' does not exist`, because the pyproject
    sits alongside the package files, not above them) — it now maps
    the package onto the current directory, carries a package README,
    license, classifiers and project URLs, and builds a clean wheel
    (only `__init__`/`client`/`tools`) verified by installing it in a
    fresh venv (17 tools build). The adapter test moved out of the
    shipped package to `tests/test_adapter.py` (`pnpm test:langchain`
    updated) so it no longer rides in the wheel. Follow-up: the actual
    `twine upload` to PyPI, which needs Paul's PyPI account/token —
    not performed here.
- [x] **Webhooks** — POST decision/execution events to a configured URL (item complete).
  - [x] 2026-10-30 — v0.15.0 webhooks (slice 1, item partial): new
    `src/webhooks/dispatcher.ts` — `WebhookDispatcher` POSTs four event
    types to a single configured URL: `intent.decided` (every submit
    decision: ALLOW / REQUIRE_APPROVAL / DENY), `intent.executed`
    (immediate and approval-path executions, with txid), `intent.denied`
    (HTTP/Telegram denies and approval-time re-evaluation DENYs), and
    `intent.execution_failed` (node failures, with the error). Payloads
    carry only public intent facts (kind, asset, qty, destination,
    decision kind/reason codes, txid/error) — no secrets, no policy
    internals. Config via `RVN_WEBHOOK_URL` (unset or non-http(s) =
    disabled, never a startup crash) and optional `RVN_WEBHOOK_SECRET`
    for HMAC-SHA256 signing (`X-Rvn-Signature: sha256=<hex>` over the
    raw body, plus an `X-Rvn-Event` header). Delivery mirrors the
    approval notifier: one retry, then the failure is audited as
    `WEBHOOK_DELIVERY_FAILED` (successes as `WEBHOOK_DELIVERY`) and
    never fails the request that produced the event. `/v1/health`
    reports `webhooks.configured`. Verified with new
    `pnpm test:webhooks` (`demo/webhook-test.ts`, 42 checks: config
    parsing, payload shape, signature determinism/verification,
    dispatcher retry/give-up/disabled behavior with injected senders,
    plus integration against a stub receiver — event order and txids
    for ALLOW/DENY/hold→approve/deny/execution-failure flows, valid
    signatures, and a down receiver still returning 200 with audited
    failures); demo, mcp-smoke, approvals, telegram-callback, simulate,
    reissue, subasset, unique, presets, anomaly, store, langchain
    suites still green. Remainder: multiple endpoints, per-event
    subscriptions/filtering, and configurable retry/backoff.
  - [x] 2026-10-31 — v0.16.0 webhooks (slice 2, item partial): multiple
    endpoints with per-event subscriptions. New `RVN_WEBHOOKS_JSON`
    env var: a JSON array of `{ url, secret?, events? }` endpoints,
    where `events` is a subset of the four event types (omitted = all
    events); the legacy `RVN_WEBHOOK_URL`/`RVN_WEBHOOK_SECRET`
    endpoint still works and is appended to the list. Malformed JSON,
    malformed entries, non-http(s) URLs, unknown event names, and
    entries whose events filter to nothing are skipped — degraded
    gracefully, never a startup crash. `WebhookDispatcher` now takes a
    list of configs; `deliver()` fans an event out to every subscribed
    endpoint (each with its own secret/signature), retries each once,
    never lets one failing endpoint block the others, and throws
    listing the failed endpoint URLs (never secrets) when any fail so
    the server audits `WEBHOOK_DELIVERY_FAILED`; it returns the
    attempted-endpoint count, and the server audits `WEBHOOK_DELIVERY`
    only when at least one endpoint was attempted. `/v1/health`
    reports `webhooks.endpoints` alongside `configured`. Verified by
    extending `pnpm test:webhooks` (now 60 checks: multi-endpoint
    config parsing incl. bad-JSON/bad-entry/unknown-event/legacy-merge
    cases, per-endpoint routing and signing, partial failure, and a
    second-API integration proving an all-events endpoint gets
    decided+executed while an executed-only endpoint gets just the
    executed event); demo, mcp-smoke, approvals, telegram-callback,
    simulate, reissue, subasset, unique, presets, anomaly, store,
    langchain suites still green. Remainder: configurable
    retry/backoff.
  - [x] 2026-11-01 — v0.17.0 webhooks (slice 3, item complete):
    configurable retry/backoff. Global defaults from
    `RVN_WEBHOOK_MAX_ATTEMPTS` (1–10, default 2 total attempts),
    `RVN_WEBHOOK_RETRY_DELAY_MS` (0–60000, default 500),
    `RVN_WEBHOOK_RETRY_BACKOFF_FACTOR` (positive, default 2), and
    `RVN_WEBHOOK_RETRY_MAX_DELAY_MS` (default 30000); a
    `RVN_WEBHOOKS_JSON` entry may override any of them per endpoint
    (`maxAttempts`, `retryDelayMs`, `backoffFactor`, `maxDelayMs`).
    Invalid values fall back to the default for that field, never a
    startup crash. Delay before retry N is
    `min(base * factor^(N-1), maxDelay)`; the dispatcher takes an
    injectable sleep so tests record delays without waiting.
    `/v1/health` reports `webhooks.retry`. Verified by extending
    `pnpm test:webhooks` (now 73 checks: env parsing incl. invalid
    fallbacks, delay math incl. the cap, per-endpoint parse and
    override-beats-global, maxAttempts 1 means no sleep, plus a
    server integration proving the env config reaches `/v1/health`);
    demo, mcp-smoke, approvals, telegram-callback, simulate, reissue,
    subasset, unique, presets, anomaly, store, langchain suites still
    green. The webhooks item is complete; the next top item is rate
    limiting.
- [x] **Rate limiting** — per-agent operation limits (token bucket) as a policy dimension (item complete).
  - [x] 2026-11-02 — v0.18.0 rate limiting (slice 1, item partial):
    new `src/policy/ratelimit.ts` — `TokenBucket` (continuous refill at
    maxOps/windowSeconds tokens per second, fractional tokens, fresh
    buckets start full, backwards clocks never drain) plus
    `rateLimitFromPolicy()` (lenient: anything malformed degrades to
    unlimited, never a crash) and `validateRateLimitFields()` (strict:
    both-or-neither, positive integers). New optional policy fields
    `rateLimitMaxOps` / `rateLimitWindowSeconds` — unset on every
    existing policy, so all prior behavior is unchanged. The server
    spends one token per agent per real submit (even one the policy
    engine would deny, so denied floods still throttle) and answers
    429 with a DENY decision (`RATE_LIMIT_EXCEEDED`, audited and
    webhook-notified like any decision, nothing executed, no hold
    created); `simulate` peeks via `wouldAllow()` and reports the DENY
    it would get without spending a token; approve/deny never touch
    the bucket. PUT validation and preset overrides enforce the
    pair-or-neither rule (half pairs 400). MCP submit tools surface
    429 as errors. Verified with new `pnpm test:ratelimit`
    (`demo/ratelimit-test.ts`, 55 checks: bucket burst/refill/peek/
    per-key isolation, parsing/validation, burst→429 with no asset
    created, per-agent isolation, simulate peek proofs, 2s-window
    refill, transfers sharing the bucket, PUT + preset validation);
    demo, mcp-smoke, approvals, telegram-callback, simulate, reissue,
    subasset, unique, presets, anomaly, store, webhooks, langchain
    suites still green. Remainder: per-kind buckets, buckets persisted
    in the store (a restart currently refills them), rate-limit stats.
  - [x] 2026-11-03 — v0.19.0 rate limiting (slice 2, item partial):
    rate-limit stats. New `TokenBucket.snapshot()` — a pure read of the
    bucket (same refill math as `wouldAllow`, but it neither spends a
    token nor stores the refilled level, so polling stats can neither
    throttle nor un-throttle an agent): whole-token balance, refill
    rate, seconds until the next token and until full, and wouldAllow;
    a never-touched bucket reports full. New `GET /v1/ratelimit/:agentId`
    — limited agents get the snapshot (resolved through the same
    agent-or-`*`-or-default policy lookup as the submit gate),
    unlimited agents get `{ limited: false }`. New `get_ratelimit` MCP
    tool and LangChain client method + tool (18 tools now), keeping
    the "adapters cover every route" invariant. Verified by extending
    `pnpm test:ratelimit` (unit snapshot checks: fresh/empty/partial
    refill math, snapshot purity; integration: exhausted/fresh/
    after-one-spend/unlimited/unknown-agent stats, plus the proof
    that reading stats leaves a 429 in place), a new MCP smoke
    section (4 checks), and `pnpm test:langchain` (18 tools, client +
    tool stats shape); demo, mcp-smoke, approvals,
    telegram-callback, simulate, reissue, subasset, unique, presets,
    anomaly, store, webhooks, langchain suites still green.
    Remainder: per-kind buckets, buckets persisted in the store.
  - [x] 2026-11-04 — v0.20.0 rate limiting (slice 3, item partial):
    buckets persisted in the store. New `TokenBucket.dump()` /
    `restore()` / `stored()` — dump returns every bucket's fractional
    balance plus the instant it was last computed, restore replays it
    (malformed states ignored, never a crash), and refill after a
    restore runs from the saved timestamp, so a restart neither
    refills an exhausted bucket nor double-counts refill. New
    `ratelimits` seam on the `Store` interface (`get` / `set` /
    `all`): a memory-map backend and a Postgres backend over a new
    `ratelimit_buckets` table in `schema.sql` (applied idempotently
    at startup like the rest of the schema; corrupt rows read as
    absent and are overwritten by the next write). The server
    restores every saved bucket at boot (a failed restore logs and
    starts from full buckets, never a startup crash) and writes a
    bucket back after every gate evaluation — including a failed
    consume, whose refilled level must not be double-counted — with
    writes chained in call order so a slow write can never overwrite
    a newer state with a stale one; a failed write is logged and
    never fails the submit. Simulate peeks and stats reads still
    never write. Verified with new persistence checks in
    `pnpm test:ratelimit` (dump/restore round-trip, refill from the
    saved timestamp, malformed-restore rejection, memory-seam
    round-trip) and a ratelimit section in `pnpm test:store`
    (both backends); demo, mcp-smoke, approvals,
    telegram-callback, simulate, reissue, subasset, unique, presets,
    anomaly, store, webhooks, langchain suites still green.
    Remainder: per-kind buckets.
  - [x] 2026-11-05 — v0.21.0 rate limiting (slice 4, item complete):
    per-kind buckets. New optional policy field
    `rateLimitKindLimits` — a map from intent kind
    (`issue_asset` / `transfer_asset` / `reissue_asset` /
    `issue_subasset` / `issue_unique`) to `{ maxOps, windowSeconds }`.
    A kind bucket layers on top of the agent-wide bucket: a submit
    must pass both, spending a token from each, so an operator can
    cap the fast, cheap op (transfers) or the supply-creating ops
    (issues) separately from the agent's total velocity. A 429 from
    either gate spends from neither bucket (peek-all-then-spend),
    while an exhausted bucket's refilled level is still recorded so
    a restart cannot double-count refill. Kind buckets are keyed
    `${agentId}:${kind}` in the same `TokenBucket`, so they persist
    through the existing `ratelimits` store seam with no schema
    change, and `GET /v1/ratelimit/:agentId` reports them under
    `kinds` (alongside the agent-wide snapshot when one exists;
    kind-only agents report `limited: true` with no top-level token
    fields). `simulate` peeks both gates and reports the DENY
    either would produce, spending nothing. Lenient parsing drops
    malformed entries per kind (unknown kind, half pair, bad values)
    so stored policies never crash the gate; PUT and preset
    overrides validate strictly (unknown kind, half pair, zero /
    fractional values all 400). MCP `get_ratelimit` / `set_policy`
    and the LangChain client proxy the route, so no new tools were
    needed — only description updates. Verified by extending
    `pnpm test:ratelimit` (now 118 checks: parsing/validation unit
    checks, kind-key dump/restore, kind-only limits, layered
    agent-wide + kind limits with the neither-spends proof, per-agent
    kind isolation, PUT + preset validation, stats-read purity) and
    a new MCP smoke section (4 checks); demo, mcp-smoke, approvals,
    telegram-callback, simulate, reissue, subasset, unique, presets,
    anomaly, store, webhooks, langchain suites still green. The
    rate-limiting item is complete.
- [x] 2026-11-06 — v0.22.0 Anomaly thresholds as policy fields + anomaly
  stats (item complete): the v0.12.0 constants are now per-agent policy
  fields — `anomalyQtyMultiple` (default 10), `anomalyMinHistory`
  (default 3), `anomalyBurstWindowSeconds` (default 3600),
  `anomalyBurstMinCount` (default 3) — resolved by
  `anomalyConfigFromPolicy()` (lenient: malformed fields fall back to
  the defaults, never a crash) and enforced strictly by
  `validateAnomalyFields()` on PUT and preset overrides (non-positive
  or non-integer values 400). `detectAnomalies` takes an optional
  config; `evaluateIntent` passes the agent's resolved config, so
  simulate runs the tuned gate with zero side effects like before. New
  read-only `GET /v1/anomaly/:agentId` (`windowHours` query, default
  24, clamped 1..168): holds raised in the window, split by signal
  (`QTY_OUTLIER` / `FIRST_SEEN_DESTINATION_BURST`, re-run under the
  current thresholds), holds still pending, and the thresholds in
  force. A hold counts when its stored decision carries
  `ANOMALY_SUSPECTED` (still-waiting, owner-denied, or approved while
  the signal still fired at re-evaluation); a hold whose re-evaluation
  no longer flags is not counted — stats describe decisions as
  recorded. New `get_anomaly_stats` MCP tool and LangChain client
  method + tool (19 tools now), keeping the "adapters cover every
  route" invariant. Verified with new checks in `pnpm test:anomaly`
  (unit parse/validate split, tighter multiple / higher min-history /
  higher burst count / 1s burst window gating, PUT + preset 400s,
  stats counts/split/pending/approved-still-counts/purity/unknown
  agent), a new MCP smoke section (7 checks), and
  `pnpm test:langchain` (19 tools, client + tool stats shape); demo,
  mcp-smoke, approvals, telegram-callback, simulate, reissue, subasset,
  unique, presets, store, webhooks, ratelimit, langchain suites still
  green.
- [x] 2026-11-07 — v0.23.0 Postgres schema migrations (item complete):
  versioned migrations replace the startup CREATE-IF-NOT-EXISTS
  `schema.sql`. New `src/store/migrations.ts` — `loadMigrations()` reads
  `<version>_<name>.sql` files from `src/store/migrations/`, rejecting
  misnamed files, duplicate versions, gaps, and a first version other
  than 0001; `applyMigrations()` bootstraps a `schema_migrations` table,
  checks the database's applied set is a prefix of the files (an unknown
  applied version — a code downgrade — or a gap in the applied set fails
  fast with a clear error), and applies each pending migration in its own
  transaction together with its `schema_migrations` row, so a failure
  rolls the migration back entirely and the error names the migration.
  `0001_initial.sql` is the old schema verbatim (IF NOT EXISTS guards
  kept, so databases created by `schema.sql` apply it as a no-op);
  `0002_decisions_kind_index.sql` adds an expression index on
  `decision->>'kind'` for the pending-intents lookup. `PostgresStore`
  runs migrations at connect and exposes `appliedMigrations` (also on
  `/v1/health`; the memory store reports `[]`). A `MigrationError` is
  never swallowed into the in-memory fallback in `storeFromEnv` — a
  broken schema fails startup loudly instead of silently splitting the
  audit chain — while an unreachable database still falls back as
  before. `docker-compose.yml` no longer mounts a schema file (the API
  migrates at startup). Verified with new `pnpm test:migrations`
  (`demo/migration-test.ts`, 31 checks: filename/validation unit
  checks, temp-dir loads, a fake-pool runner — fresh apply in order,
  one transaction per migration, idempotent re-run, failing 0002
  rolls back with no row and succeeds on retry, downgrade/gap
  fail-fast — plus a live leg against a scratch database when
  `TEST_DATABASE_URL` is set, and a health check; live leg skipped
  here, no local Postgres). `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`, `pnpm test:subasset`,
  `pnpm test:unique`, `pnpm test:presets`, `pnpm test:anomaly`,
  `pnpm test:store`, `pnpm test:webhooks`, `pnpm test:ratelimit`,
  `pnpm test:langchain` still green. Follow-ups: the audit
  partitioning below is the first consumer of a real schema change.
- [x] **Audit retention & partitioning** — the v0.7.0 follow-up: as the
  hash chain grows, partition `audit_entries` by time (monthly
  partitions) and add a retention policy (archive partitions older
  than N days to cold storage with a chain-verification proof, then
  drop them), so verification stays fast and the database stays
  bounded without breaking the chain's verifiability.
  - [x] 2026-11-08 — v0.24.0 archive export + chain-proof + retention
    pruning (slice 1, item partial): new `src/audit/archive.ts` —
    `buildArchive()` exports a contiguous slice as a self-contained
    document (seq range, first entry's prevHash, head hash),
    `verifyArchive()` re-verifies the document (header + internal
    chain), and `verifyContinuity()` proves the retained chain starts
    exactly where the archive ended (oldest retained entry links to
    the head hash at lastSeq + 1). Retention config from
    `RVN_AUDIT_RETENTION_DAYS` (1–3650, default 90) and
    `RVN_AUDIT_ARCHIVE_DIR` (default `audit-archives/`), lenient
    parsing like the webhook/rate-limit config. `verifyChain` takes
    an anchor prevHash, so a pruned chain still verifies — the anchor
    is the archived head hash instead of `GENESIS`. New `AuditStore`
    seam (`oldest` / `beforeMs` / `prune`, always keeping the newest
    entry as the chain anchor) on both backends. New
    `POST /v1/audit/archive` (optional `beforeMs`, default = the
    retention cutoff; at most 10,000 entries per call): writes the
    archive file before pruning anything, refuses with 500 on a
    broken chain or a failed write, records the proof in-chain as an
    `AUDIT_ARCHIVED` entry, and reports continuity — entries appended
    concurrently survive the prune (they get a seq above the archived
    range) and are picked up by the next run. New `archive_audit` MCP
    tool and LangChain client method + tool (20 tools now), keeping
    the "adapters cover every route" invariant. `/v1/health` reports
    the retention config. Verified with new `pnpm test:archive`
    (`demo/archive-test.ts`, 57 checks: archive/continuity/config
    units, the memory-store prune seam, and a booted-API integration
    — file written, entries pruned, chain valid, continuity holds),
    new prune checks in `pnpm test:store` (both backends), an MCP
    smoke section, and `pnpm test:langchain` (20 tools, client + tool
    archive shape); demo, mcp-smoke, approvals,
    telegram-callback, simulate, reissue, subasset, unique, presets,
    anomaly, store, webhooks, ratelimit, migrations suites still
    green. Remainder: monthly declarative partitioning of
    `audit_entries` in Postgres (a table-rebuild migration; the
    archive/prune flow already works on the unpartitioned table).
  - [x] 2026-11-09 — v0.25.0 monthly partitioning (slice 2, item
    complete): migration `0003_audit_entries_partitioning` rebuilds
    `audit_entries` as a monthly range-partitioned table on `at_ms`
    (UTC months, `audit_entries_YYYY_MM`), creating one partition per
    month holding data plus the current month and the next two, then
    copying every row, dropping the old table, and renaming — all
    inside the migration transaction. The primary key becomes
    `(seq, at_ms)` (a partitioned PK must include the partition key);
    seq stays unique in practice via the advisory-locked append, and
    the chain hash remains the integrity check. New
    `src/store/partitions.ts` — `auditPartitionFor()` (UTC month
    bounds) and `auditPartitionDdl()` — and `PostgresAuditStore.append`
    creates the entry's month on demand inside its locked transaction,
    so a month boundary can never fail an append. `/v1/health`
    reports `audit.partitioned`. Verified with new
    `pnpm test:partition` (32 checks, live leg against a real
    Postgres: rebuild of a pre-existing unpartitioned table preserves
    every row in its own month's partition, chain verifies, appends
    land in the current month's partition, a far-future month refuses
    a raw insert until the DDL runs, prune still works) plus the
    migration-test updates; demo, mcp-smoke, approvals,
    telegram-callback, simulate, reissue, subasset, unique, presets,
    anomaly, store (Postgres leg live for the first time on this VM),
    webhooks, ratelimit, langchain suites still green. One bug caught
    by the live dry run and fixed before landing: month arithmetic on
    `timestamptz` drifts across DST in a non-UTC session timezone and
    skipped 2025_11 entirely — the migration now iterates on
    `timestamp` (UTC wall clock) instead. The audit retention &
    partitioning item is complete; the next top item is the ops
    metrics endpoint.
- [x] 2026-11-10 — v0.26.0 Ops metrics endpoint (item complete): new
  `GET /v1/metrics` (JSON, no new deps) — decision counts by kind and
  reason code, rate-limit 429s by agent and kind, webhook delivery
  successes/failures by endpoint, approval hold age (oldest pending),
  and the store backend — so an operator can monitor the API without
  scraping the audit log. Read-only and unauthenticated like
  `/v1/health`; the payload carries no policy internals and no secrets.
  New `src/ops/metrics.ts` — pure `computeMetrics()` aggregates the
  retained audit chain at request time (DECISION entries with a real
  decision kind; POLICY_REPLACED policy-update entries excluded;
  approval-time re-evaluation DENYs counted, approvals themselves write
  no DECISION entry so they change nothing; 429s from the
  RATE_LIMIT_EXCEEDED reason code grouped by agent and intent kind;
  webhook entries grouped by endpoint URL, with pre-v0.26.0 entries
  that carry no endpoint counted under `unknown`). Counts cover the
  retained chain only — archived slices live in the archive files —
  and the response says so via `audit.entries`. New `AuditStore.all()`
  seam (both backends; `AuditLog.all()` in-memory) supplies the entries.
  Per-endpoint webhook counts needed the audit to record the endpoint:
  `WebhookDispatcher` gained `deliverDetailed()` (per-endpoint outcomes;
  a throwing sender marks that endpoint failed instead of aborting the
  fan-out) alongside the unchanged `deliver()` (same throw/count
  behavior, now sharing the extracted `attemptEndpoint` retry loop), and
  the server audits one WEBHOOK_DELIVERY / WEBHOOK_DELIVERY_FAILED entry
  per endpoint with `{ event, endpoint }` — a partial failure now
  records both the delivered and the failed endpoints instead of one
  FAILED entry for the whole event. New `get_metrics` MCP tool and
  LangChain client method + tool (21 tools now), keeping the "adapters
  cover every route" invariant. Verified with new `pnpm test:metrics`
  (`demo/metrics-test.ts`, 30 checks: computeMetrics units incl.
  malformed detail, a booted-API integration — fresh zeros, ALLOW/DENY/
  hold counts with the right reason codes, POLICY_REPLACED exclusion,
  approve writes no DECISION entry, exactly one 429 by agent and kind,
  read purity — plus a stub-receiver integration proving delivered then
  failed counts per endpoint URL), new `all()` checks in
  `pnpm test:store`, an MCP smoke section, and `pnpm test:langchain`
  (21 tools, client + tool metrics shape); demo, mcp-smoke, approvals,
  telegram-callback, simulate, reissue, subasset, unique, presets,
  anomaly, store, archive, migrations, partition, webhooks, ratelimit
  suites still green. The ops metrics item is complete; the next top
  item is multi-approver quorum.
- [ ] **Multi-approver quorum for high-value holds** — a second,
  higher approval threshold in policy: intents above it need N of M
  distinct approvers instead of one. Telegram buttons count distinct
  approvers (same approver tapping twice counts once); the HTTP
  approve route takes an approver identity and reports
  `approvals: n/N` until quorum is met, then executes. A single
  approver still suffices below the quorum threshold, so existing
  flows are unchanged.
  - [x] 2026-11-11 — v0.27.0 quorum policy + approval counting (slice 1,
    item partial): new `src/policy/quorum.ts` — `quorumConfigFromPolicy()`
    (lenient: quorum is active only when `quorumApprovals` is an integer
    >= 2 AND at least one threshold parses; anything else degrades to no
    quorum, never a crash) and `validateQuorumFields()` (strict:
    all-or-nothing — a count with no threshold, or a threshold with no
    count, is rejected, as is a count below 2). New optional policy
    fields `quorumApprovals`, `quorumAboveIssueQtyBaseUnits` and
    `quorumAboveTransferQtyBaseUnits`, validated on PUT and preset
    overrides. `evaluateIntent` attaches `quorumRequired: N` to every
    REQUIRE_APPROVAL decision whose qty sits above the applicable quorum
    threshold (the reason stays the earlier hold reason — e.g.
    ABOVE_APPROVAL_THRESHOLD — when the intent was already held) and
    holds a would-be-ALLOW intent with reason `QUORUM_REQUIRED`.
    `resolveApproval` counts distinct approver identities on the stored
    decision (`Decision.approvals`, persisted with the decision in both
    stores, so a restart cannot lose the count): a first approval
    returns 202 with `approvalsReceived`/`approvalsRequired` and
    executes nothing, a repeat from the same approver returns 202 with
    `alreadyCounted: true` and the count unchanged, and the Nth distinct
    approver executes (200 + txid, 2/2 in the response). A deny by any
    single approver still ends the hold outright, and the stored quorum
    requirement governs even if the policy changed after the hold. The
    Telegram webhook shares the same path, so a tap from the same
    `telegram:<name>` identity counts once and a partial approval
    answers with the n/N toast instead of editing the hold message.
    `simulate` reports the quorum decision with zero side effects.
    Verified with new `pnpm test:quorum` (`demo/quorum-test.ts`, 57
    checks), a new MCP smoke section (5 checks), and
    `pnpm test:langchain` (21 tools — no new tool: `approve_intent`
    already proxies the route, and its description now names the quorum
    progress); demo, mcp-smoke, approvals, telegram-callback,
    simulate, reissue, subasset, unique, presets, anomaly, store,
    archive, migrations, partition, webhooks, ratelimit, metrics
    suites still green. Remainder: an approver roster (M) — a
    policy-defined set of approver identities, so only roster members
    count toward quorum and a pending hold can report n/N of M.

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
