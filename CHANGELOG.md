# Changelog

## 2026-11-07 — v0.23.0 (Postgres schema migrations, item complete)

- Versioned migrations replace the startup CREATE-IF-NOT-EXISTS
  `schema.sql` (deleted; its GitHub copy stays until a
  deletion-capable push — `push-files` only creates/updates). New
  `src/store/migrations.ts`: `loadMigrations()` reads
  `<version>_<name>.sql` files from `src/store/migrations/`,
  rejecting misnamed files, duplicate versions, gaps, and a first
  version other than 0001; `applyMigrations()` bootstraps a
  `schema_migrations` table, verifies the database's applied set is a
  prefix of the files (an unknown applied version — a code downgrade
  — or a gap in the applied set fails fast with a clear error), and
  applies each pending migration in its own transaction together with
  its `schema_migrations` row, so a failed migration rolls back
  entirely — there is no half-applied state — and the error names the
  migration that failed. The runner needs only a pool with
  `query`/`connect`, so it is testable without a live database.
- `0001_initial.sql` is the old schema verbatim (all IF NOT EXISTS
  guards kept, so a database created by `schema.sql` applies it as a
  no-op and just records it); `0002_decisions_kind_index.sql` is the
  first real schema evolution — an expression index on
  `decision->>'kind'` so the pending-intents lookup stops scanning
  the decisions table as held intents accumulate. Adding a migration
  is now: add `NNNN_name.sql` to `src/store/migrations/` and restart.
- `PostgresStore.connect` runs the migrations instead of the old
  schema blob and exposes `appliedMigrations` (new `Store` field;
  the memory store reports `[]`); `/v1/health` reports it too, so an
  operator can see which schema version is live. A `MigrationError`
  is never swallowed into the in-memory fallback in `storeFromEnv`:
  a broken schema fails startup loudly instead of silently splitting
  the audit chain and losing persistence; an unreachable database
  still falls back to memory as before. `docker-compose.yml` no
  longer mounts a schema file — the API migrates at startup.
- New `pnpm test:migrations` (`demo/migration-test.ts`, 31 checks):
  filename parsing and set-validation unit checks, temp-directory
  loads (misnamed file and gap rejected), a fake-pool runner proving
  fresh apply in order with one transaction per migration, idempotent
  re-run, a failing 0002 rolling back (no row, no committed
  statements) and succeeding on retry, downgrade and gap fail-fast,
  plus a live leg against a scratch database when `TEST_DATABASE_URL`
  is set (skipped here — no local Postgres) and a health check
  proving `/v1/health` reports `migrations: []` on the memory store.
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:webhooks`, `pnpm test:ratelimit`,
  `pnpm test:langchain` still green. `initialize` now reports server
  version 0.23.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`).
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:migrations` script.
  One test-found bug fixed in the same session: the migration
  filename regex rejected underscores, so the shipped
  `0002_decisions_kind_index.sql` itself would not have loaded.
- The Postgres schema migrations roadmap item is complete; the next
  top item is audit retention & partitioning.

## 2026-11-06 — v0.22.0 (Anomaly thresholds as policy fields + anomaly stats, item complete)

- The anomaly detector's v0.12.0 constants are now per-agent policy
  fields, so an operator can tune sensitivity without redeploying:
  `anomalyQtyMultiple` (qty must exceed this multiple of the
  same-kind median qty, default 10), `anomalyMinHistory` (minimum
  same-kind samples before a qty outlier can fire, default 3),
  `anomalyBurstWindowSeconds` (burst window, default 3600), and
  `anomalyBurstMinCount` (minimum intents in the window before a
  first-seen destination flags, default 3). Every field is optional;
  an unset or malformed field falls back to its default, so older
  policies keep the exact behavior they had.
- New `AnomalyConfig` in `src/policy/anomaly.ts` with the established
  lenient/strict split: `anomalyConfigFromPolicy()` resolves a policy
  to a config (malformed fields degrade to defaults per field, never
  a crash), `validateAnomalyFields()` rejects non-positive or
  non-integer values strictly for PUT `/v1/policies/:agentId` and
  preset overrides (400, nothing stored). `detectAnomalies()` takes
  an optional config (defaulting to the v0.12.0 constants);
  `evaluateIntent` passes the agent's resolved config, so the tuned
  gate rides the existing submit, approval-time re-evaluation, and
  simulate paths unchanged. `applyPreset` accepts all four fields as
  overrides with the same positive-integer check.
- New read-only `GET /v1/anomaly/:agentId` (`windowHours` query,
  default 24, clamped to 1..168): the anomaly holds the gate raised
  over the window, split by signal (`QTY_OUTLIER` /
  `FIRST_SEEN_DESTINATION_BURST`), the holds still pending, and the
  thresholds currently in force — so the hold-not-deny gate is
  observable without scraping the audit log. A hold counts when its
  stored decision carries `ANOMALY_SUSPECTED` (still waiting,
  owner-denied, or approved while the signal still fired at
  re-evaluation); the per-signal split re-runs the detector over each
  counted intent against the history that preceded it, under the
  agent's current thresholds. A stats read writes nothing (no intents,
  no audit entries, no baseline pollution).
- Adapters keep the "cover every route" invariant: new
  `get_anomaly_stats` MCP tool (proxying the route, with an optional
  `windowHours`) and a LangChain client method + tool (`langchain_rvn`
  now builds 19 tools). The MCP `set_policy` / `apply_preset`
  descriptions now name the anomaly fields.
- `pnpm test:anomaly` extended (unit checks for the parse/validate
  split; integration — tighter multiple 2 holds qty 250 while exactly
  2x ALLOWs, minHistory 5 delays flagging until 5 samples exist,
  burstMinCount 5 defuses a 3-intent burst, a 1s burst window ages out,
  six PUT 400 cases that leave the default policy untouched, preset
  override gating + a 400 case, and stats — 2 holds over 5 intents
  split 1/1 by signal, 2 pending, approved hold still counts as
  raised with pending dropping to 1, read purity, unknown agent zeros
  with defaults) — all green. `demo/mcp-smoke.ts` gained an anomaly
  section (7 checks: set_policy with a threshold, fresh-agent stats,
  baseline ALLOWs, multiple-2 hold, stats split). `pnpm test:langchain`
  updated (19 tools, client + tool stats shape) — all green.
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:store`, `pnpm test:webhooks`,
  `pnpm test:ratelimit` still green. `initialize` now reports server
  version 0.22.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README route table gained the
  anomaly (and previously missing rate-limit) rows.
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content.
- The anomaly-thresholds roadmap item is complete; the next top item
  is Postgres schema migrations.

## 2026-11-05 — v0.21.0 (Rate limiting, slice 4 — item complete)

- Per-kind rate-limit buckets, layered on top of the agent-wide bucket.
  New optional policy field `rateLimitKindLimits`: a map from intent
  kind (`issue_asset`, `transfer_asset`, `reissue_asset`,
  `issue_subasset`, `issue_unique`) to `{ maxOps, windowSeconds }`.
  A submit must pass both its agent-wide bucket (when the policy sets
  the pair) and its kind bucket (when the policy sets one for that
  kind), spending a token from each — so an operator can cap the fast,
  cheap op (transfers) or the supply-creating ops (issues) separately
  from the agent's total velocity. A 429 from either gate spends from
  neither bucket: the server peeks every configured gate first and
  only then consumes, so a kind-limit 429 never burns an agent-wide
  token (and vice versa); an exhausted bucket's refilled level is
  still recorded, exactly as the single-bucket gate already did, so a
  restart cannot double-count refill.
- Kind buckets are keyed `${agentId}:${kind}` in the same `TokenBucket`,
  so they persist through the existing `ratelimits` store seam with no
  schema change — restored at boot, written back after every gate
  evaluation, chained in call order like the agent-wide buckets.
  `GET /v1/ratelimit/:agentId` reports per-kind snapshots under
  `kinds` for every kind the policy limits (alongside the agent-wide
  snapshot when one exists; kind-only agents report `limited: true`
  with no top-level token fields, and unlimited agents still report
  `{ limited: false, kinds: {} }`). `POST /v1/intents/simulate`
  peeks both gates and reports the DENY either would produce, spending
  nothing. No new REST route or MCP/LangChain tool: the kind buckets
  ride the existing submit, simulate, and stats routes, and the MCP
  `get_ratelimit` / `set_policy` descriptions now name the field.
- Parsing follows the established lenient/strict split:
  `rateLimitsPerKindFromPolicy()` drops malformed entries per kind
  (unknown kind, half pair, non-positive or non-integer values) so a
  bad stored policy degrades to unlimited for that kind, never a
  crash; `validateRateLimitKindFields()` rejects the same cases
  strictly for PUT `/v1/policies/:agentId` and for preset overrides
  (unknown kind, half pair, zero/fractional values all 400), and
  `applyPreset` accepts `rateLimitKindLimits` as an override field
  with the same per-kind error messages.
- `pnpm test:ratelimit` extended to 118 checks: kind-key format,
  lenient parse (valid map, unknown kind, half pair, zero/fractional,
  non-object entry dropped), strict validation (all rejection paths),
  kind-key dump/restore round-trip with isolation from the bare agent
  key, plus integration — kind-only limits (2 issues then 429 while
  transfers still ALLOW, simulate issue DENY / transfer ALLOW, stats
  under `kinds`), layered limits (4 ops agent-wide + 2 issues: third
  issue 429s while the agent bucket still has 2, transfers then drain
  it to a 429, stats show both buckets at 0), per-agent kind
  isolation, PUT and preset validation for kind maps, stats-read
  purity for kind buckets — all green. `demo/mcp-smoke.ts` gained a
  per-kind section (4 checks: set_policy with a kind limit, `kinds`
  full, issue ALLOWs once, kind bucket exhausted). `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:webhooks`, `pnpm test:langchain` still green.
  `initialize` now reports server version 0.21.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`).
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content.
- The rate-limiting roadmap item is complete; the next top items are
  the five newly appended backlog items (anomaly thresholds as policy
  fields + stats, Postgres schema migrations, audit retention &
  partitioning, ops metrics endpoint, multi-approver quorum).

## 2026-11-04 — v0.20.0 (Rate limiting, slice 3 — item partial)

- Rate-limit buckets persisted in the store, so a restart no longer
  refills an exhausted bucket. `TokenBucket` gains `dump()` (every
  bucket's fractional balance plus the instant it was last computed),
  `restore(key, state)` (replays a saved bucket; malformed states —
  non-finite or negative numbers — are ignored, never stored), and
  `stored(key)` (a copy of one bucket's live state, for writing
  back). Refill after a restore runs from the saved timestamp: a
  bucket saved with 1 token at t=1000 on a 3-op/60s limit still has
  exactly 2 tokens at t=21000, not a fresh 3. A restored balance
  above a since-changed capacity is harmless — refill math clamps
  it on the next evaluation.
- New `ratelimits` seam on the `Store` interface (`get` / `set` /
  `all`): a memory-map backend, and a Postgres backend over a new
  `ratelimit_buckets` table (`key` primary key, fractional `tokens`,
  `updated_ms` epoch milliseconds) added to `src/store/schema.sql`
  and applied idempotently at startup like the rest of the schema.
  Corrupt rows (a NaN can sit in a DOUBLE PRECISION column) read
  as absent and are overwritten by the next write, so bad data can
  never take the gate down.
- Server wiring: every saved bucket is restored at boot (a failed
  restore logs a warning and starts from full buckets — never a
  startup crash), and every gate evaluation writes its bucket back,
  including a failed consume, whose refilled level must not be
  double-counted after a restart. Persist writes are chained in call
  order so a slow write can never overwrite a newer state with a
  stale one, and a failed write is logged and never fails the
  submit that produced it. Simulate peeks and stats reads still
  never write. No new REST route or MCP/LangChain tool: the
  persisted bucket is the same bucket the existing stats endpoint
  already reports. `initialize` now reports server version 0.20.0
  (`src/mcp.ts`, `package.json`, `langchain_rvn/pyproject.toml`).
- `pnpm test:ratelimit` gained persistence checks (dump shape,
  stored-copy isolation, restore resuming a partially spent bucket,
  refill from the saved timestamp, malformed-restore rejection,
  memory-seam set/get/all round-trip) and `pnpm test:store` gained
  a ratelimit section run against both backends (the Postgres leg
  runs when a test database is configured; here it ran against the
  memory backend only, as no local Postgres is available) — all
  green. `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:webhooks`, `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content.
- Remainder of the rate-limiting item: per-kind buckets. The next
  top item remains rate limiting.

## 2026-11-03 — v0.19.0 (Rate limiting, slice 2 — item partial)

- Rate-limit stats, read-only by construction. New
  `TokenBucket.snapshot()` in `src/policy/ratelimit.ts`: the current
  whole-token balance (fractional refill rounded down), refill rate in
  tokens per second, seconds until the next whole token and until the
  bucket is full, and `wouldAllow` — computed with the same refill
  math as `wouldAllow()`, but pure: it neither spends a token nor
  stores the refilled level, so polling stats can neither throttle
  nor un-throttle an agent. A bucket at exactly N tokens needs one
  full token's refill for the next whole token, not zero; a
  never-touched bucket reports full.
- New `GET /v1/ratelimit/:agentId`: the agent's policy is resolved
  through the same agent-or-`*`-or-default lookup as the submit gate,
  so the stats always describe the limit actually enforced. Limited
  agents get `{ agentId, limited: true, maxOps, windowSeconds,
  tokensAvailable, refillRatePerSecond, secondsUntilNextToken,
  secondsUntilFull, wouldAllow }`; unlimited agents (including
  never-seen ones on the default policy) get
  `{ agentId, limited: false }`. No new policy fields, no audit
  entries, no webhook events — a stats read is not an operation.
- Adapters keep the "cover every route" invariant: new
  `get_ratelimit` MCP tool (proxying the route) and a LangChain
  client method + tool (`langchain_rvn` now builds 18 tools).
  `initialize` now reports server version 0.19.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`).
- `pnpm test:ratelimit` extended (unit snapshot checks — fresh
  bucket full, exhausted bucket 0 tokens with 20s to next / 60s to
  full on a 3-op/60s bucket, partial refill 1.5 tokens -> 1 whole
  with 10s to next / 30s to full, snapshot purity across two reads
  and three subsequent consumes; integration — exhausted agent
  stats with ~1200s to the next token, stats reads leaving a 429 in
  place, unlimited/unknown agents reporting `limited: false`, a
  fresh 2-op bucket reporting full and 1 token after one spend) —
  all green. `demo/mcp-smoke.ts` gained a rate-limit section (4
  checks: full bucket, 1 token after one spend, unlimited agent).
  `pnpm test:langchain` updated (18 tools, client + tool stats
  shape) — all green. `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`, `pnpm test:subasset`,
  `pnpm test:unique`, `pnpm test:presets`, `pnpm test:anomaly`,
  `pnpm test:store`, `pnpm test:webhooks` still green.
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content.
- Remainder of the rate-limiting item: per-kind buckets and buckets
  persisted in the store (a restart currently refills them). The
  next top item remains rate limiting.

## 2026-11-02 — v0.18.0 (Rate limiting, slice 1 — item partial)

- Per-agent token-bucket rate limiting as a policy dimension. New
  optional policy fields `rateLimitMaxOps` (bucket capacity, in
  operations) and `rateLimitWindowSeconds` (the window over which a
  full bucket refills) — both must be set together; either missing
  means unlimited, so every pre-existing policy keeps working
  unchanged. The bucket refills continuously at
  maxOps/windowSeconds tokens per second, so a 10-op / 60s bucket
  allows a burst of 10, then roughly one op every 6s sustained.
- New `src/policy/ratelimit.ts`: a `TokenBucket` keyed by agent (one
  bucket per agent, shared across all operation kinds in this slice),
  `rateLimitFromPolicy()` (lenient parse for stored policies —
  malformed values degrade to unlimited, never a startup crash), and
  `validateRateLimitFields()` (strict pair-or-neither, positive
  integers, for PUT and preset-override writes). Fractional refill
  uses a 1e-9 epsilon so a bucket refilled to exactly one token is
  not denied by floating-point error.
- Server gate in `submit()`: one token is spent on every real submit
  — even one the policy engine would deny, so a flood of denied
  attempts still throttles — and an exhausted bucket answers 429
  with a DENY decision (`RATE_LIMIT_EXCEEDED`), audited as DECISION
  and webhook-notified as `intent.decided` like any decision, but
  with nothing executed and no approval hold created.
  `POST /v1/intents/simulate` peeks instead of spending: it reports
  the DENY an exhausted bucket would produce, with zero side effects
  (no intent stored, no audit entry, no token spent). Approving or
  denying a hold never touches the bucket — resolving a hold is not a
  new operation. PUT `/v1/policies/:agentId` and preset overrides
  reject half pairs and non-positive/fractional values with 400;
  `applyPreset` gains `rateLimitMaxOps`/`rateLimitWindowSeconds` as
  overridable fields. MCP submit tools surface a 429 as an error, so
  agents see the limit instead of a success-shaped payload; no new
  REST route or MCP tool (the limit rides the existing submit
  routes). `initialize` now reports server version 0.18.0
  (`src/mcp.ts`, `package.json`, `langchain_rvn/pyproject.toml`).
- New `pnpm test:ratelimit` (`demo/ratelimit-test.ts`, 55 checks):
  bucket unit checks (burst, exact-boundary refill, peek-without-
  consuming, per-key isolation, backwards clock), parsing/validation
  checks, and a booted-API integration — 3-op burst then 429 with no
  asset created and nothing pending, per-agent isolation (an
  unlimited agent issues freely while the limited one is exhausted),
  simulate peek proofs (ALLOW twice, then DENY once spent, with no
  audit entries), refill over a 2s window, transfers sharing the
  agent's bucket, PUT and preset-override validation — all green.
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:webhooks`, `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:ratelimit` script.
- Remainder of the rate-limiting item: per-kind buckets, buckets
  persisted in the store (a restart currently refills them), and
  rate-limit stats. The next top item remains rate limiting.

## 2026-11-01 — v0.17.0 (Webhooks, slice 3 — item complete)

- Configurable webhook retry/backoff. Global defaults from the
  environment: `RVN_WEBHOOK_MAX_ATTEMPTS` (1–10, default 2 total
  attempts, so the historical one-retry behavior is unchanged),
  `RVN_WEBHOOK_RETRY_DELAY_MS` (0–60000, default 500),
  `RVN_WEBHOOK_RETRY_BACKOFF_FACTOR` (positive, default 2), and
  `RVN_WEBHOOK_RETRY_MAX_DELAY_MS` (default 30000). A
  `RVN_WEBHOOKS_JSON` entry may override any of them per endpoint
  (`maxAttempts`, `retryDelayMs`, `backoffFactor`, `maxDelayMs`) —
  e.g. a flaky dashboard endpoint gets more attempts while a
  latency-sensitive one gets fewer. The delay before retry N is
  `min(baseDelayMs * backoffFactor^(N-1), maxDelayMs)`. Invalid
  values (non-numeric, out of range, non-positive factor) fall back
  to the default for that field, never a startup crash, and
  per-endpoint overrides win over the globals.
- `WebhookDispatcher` takes an optional `{ retry, sleep }` options
  argument (the two-argument constructor form still works); the
  server builds it from the environment via
  `webhookDispatcherFromEnv()`, so no route changes were needed.
  `/v1/health` now reports `webhooks.retry` alongside `configured`
  and `endpoints`. No new REST route or MCP tool: webhooks are
  outbound server configuration.
- `pnpm test:webhooks` extended to 73 checks: retry env parsing
  (valid overrides, invalid/out-of-range fallbacks), delay math
  (exponential growth, the max-delay cap, factor 1 flat),
  per-endpoint retry parsing (valid overrides kept, invalid fields
  dropped with the endpoint kept), dispatcher behavior with an
  injected sleep (global config drives attempt count and the
  100/200/400ms delay sequence, per-endpoint override beats global,
  maxAttempts 1 sleeps never), plus a server integration proving
  the env config reaches `/v1/health` — all green. `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:langchain` still green. `initialize` now reports
  server version 0.17.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`).
- Environment note: no `pnpm` binary on this VM — verification ran
  the direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content.
- The webhooks roadmap item is complete; the next top item is rate
  limiting.

## 2026-10-31 — v0.16.0 (Webhooks, slice 2 — item partial)

- Multiple webhook endpoints with per-event subscriptions. New
  `RVN_WEBHOOKS_JSON` env var: a JSON array of `{ url, secret?,
  events? }` endpoints, where `events` is a subset of the four event
  types (`intent.decided`, `intent.executed`, `intent.denied`,
  `intent.execution_failed`) and an omitted `events` means all events.
  The legacy `RVN_WEBHOOK_URL` / `RVN_WEBHOOK_SECRET` endpoint still
  works and is appended to the list. Malformed JSON, malformed
  entries, non-http(s) URLs, unknown event names, and entries whose
  events filter to nothing are skipped — degraded gracefully, never a
  startup crash.
- `WebhookDispatcher` now takes a list of endpoint configs
  (`webhookConfigsFromEnv()`; the single-config constructor form still
  works). `deliver()` fans an event out to every subscribed endpoint,
  each signed with its own secret when set, retries each once, never
  lets one failing endpoint block the others, and throws listing the
  failed endpoint URLs (never secrets) when any fail — the server
  audits that as `WEBHOOK_DELIVERY_FAILED` as before. `deliver()`
  returns the attempted-endpoint count, and the server audits
  `WEBHOOK_DELIVERY` only when at least one endpoint was attempted, so
  an event no endpoint subscribes to is not recorded as delivered.
  `/v1/health` reports `webhooks.endpoints` alongside `configured`.
- `pnpm test:webhooks` extended to 60 checks: multi-endpoint config
  parsing (bad JSON, bad entries, unknown event names, empty events,
  legacy merge), per-endpoint routing and signing with injected
  senders, partial failure (one endpoint down, the other still
  delivered, error names only the failed URL), zero-subscriber
  no-op, plus a second-API integration proving an all-events endpoint
  receives decided+executed while an executed-only endpoint receives
  just the executed event — all green. `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`, `pnpm test:subasset`,
  `pnpm test:unique`, `pnpm test:presets`, `pnpm test:anomaly`,
  `pnpm test:store`, `pnpm test:langchain` still green. No new REST
  route or MCP tool: webhooks are outbound server configuration.
  `initialize` now reports server version 0.16.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`).
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`,
  plus a fresh venv Python with langchain-core for the adapter test);
  `package.json` scripts are unchanged in content.
- Remainder of the webhooks item: configurable retry/backoff.

## 2026-10-30 — v0.15.0 (Webhooks, slice 1 — item partial)

- New `src/webhooks/dispatcher.ts`: a `WebhookDispatcher` that POSTs
  decision/execution events to a single configured URL. Four event
  types: `intent.decided` (fired on every submit decision — ALLOW,
  REQUIRE_APPROVAL, or DENY), `intent.executed` (immediate executions
  and approval-path executions, carrying the txid), `intent.denied`
  (HTTP/Telegram denies and approval-time re-evaluation DENYs, with the
  final decision including `DENIED_BY_OWNER`), and
  `intent.execution_failed` (node failures, carrying the error message).
  Payloads (`version: 1`, `atMs`, intent id/agent, kind/asset/qty/
  destination, decision kind + reason codes, txid/error) contain only
  public intent facts — no secrets and no policy internals.
- Config via `RVN_WEBHOOK_URL` and optional `RVN_WEBHOOK_SECRET`: an
  unset URL disables webhooks entirely (the API behaves exactly as
  before), and a malformed or non-http(s) URL degrades to disabled
  rather than crashing startup. With a secret set, every delivery
  carries `X-Rvn-Signature: sha256=<hex>` (HMAC-SHA256 over the raw
  JSON body) and `X-Rvn-Event`; the secret never appears in logs,
  audit entries, or payloads. Delivery retries once after a brief
  backoff, then the failure is audited as `WEBHOOK_DELIVERY_FAILED`
  (successes as `WEBHOOK_DELIVERY`, both new `AuditKind`s) and never
  fails the request that produced the event — the same stance as
  approval-notification failures. `/v1/health` reports
  `webhooks.configured`.
- New `pnpm test:webhooks` (`demo/webhook-test.ts`, 42 checks):
  config parsing (missing/malformed/non-http URLs disable cleanly),
  payload shape and secret hygiene, signature determinism and
  verification against node crypto, dispatcher retry-then-success,
  give-up-after-two-attempts, and disabled no-op behavior (all with
  injected senders), plus an integration run of the real API behind a
  stub receiver covering ALLOW (decided → executed, txid, valid
  signature), DENY (decided only), hold → approve (executed on
  approval, nothing before), hold → deny (`intent.denied` with
  `DENIED_BY_OWNER`), duplicate-asset execution failure (decided →
  execution_failed, 502), and a down receiver (request still 200,
  retries observed, `WEBHOOK_DELIVERY_FAILED` audited, chain valid) —
  all green. `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:langchain` still green. No new REST route or MCP tool:
  webhooks are outbound server configuration, not a callable route, so
  the MCP/LangChain surfaces are unchanged. `initialize` now reports
  server version 0.15.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`).
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`,
  plus a fresh venv Python with langchain-core for the adapter test);
  `package.json` scripts are unchanged in content apart from the new
  `test:webhooks` script.
- Remainder of the webhooks item: multiple endpoints, per-event
  subscriptions/filtering, and configurable retry/backoff.

## 2026-10-29 — v0.14.0 (LangChain tool adapter, slice 2 — item complete)

- New `langchain_rvn/examples/agent_executor.py`: a worked agent-executor
  example that runs a complete tool-calling loop against a local API on
  the mock node — allowlist the destination in the example agent's
  policy, then simulate → issue → audit — using langchain-core's
  deterministic `GenericFakeChatModel` in place of a real chat model, so
  it needs no LLM key and touches nothing beyond localhost. The loop
  invokes tools by name from the model's tool calls and feeds results
  back as `ToolMessage`s; a REQUIRE_APPROVAL result reports the held
  intent id and stops instead of auto-approving. Swapping the fake model
  for a real chat model bound to the tools (`model.bind_tools(tools)`)
  turns the same loop into a live agent. Verified end to end against a
  booted mock-node API: simulate ALLOW, issue ALLOW with txid, audit
  chain valid, exit 0 (the default policy holds issues to unlisted
  destinations, which is why the example allowlists first — the same
  step the TS demo takes).
- PyPI packaging, fixed for real: the v0.13.0 `pyproject.toml` could not
  build at all — `python -m build` failed with `package directory
  'langchain_rvn' does not exist`, because that pyproject sits alongside
  the package files rather than in a parent directory. It now sets
  `package-dir = { "langchain_rvn" = "." }`, and carries a package
  README (`langchain_rvn/README.md`: install, usage, example, license),
  AGPL-3.0-only license metadata, author, classifiers, keywords, and
  project URLs. Verified: `python -m build` produces a wheel whose only
  package modules are `__init__`/`client`/`tools`, and installing that
  wheel in a fresh venv imports cleanly and builds all 17 tools. The
  adapter test moved from inside the shipped package to
  `tests/test_adapter.py` (the `test:langchain` script updated; the
  test's path math is unchanged since `tests/` sits directly under the
  repo root), so the test no longer rides in the wheel. The package is
  not on PyPI yet — the actual `twine upload` needs Paul's PyPI
  account/token and was not performed.
- `initialize` now reports server version 0.14.0 (`src/mcp.ts`
  serverInfo, `package.json`, `langchain_rvn/pyproject.toml`).
  Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`,
  plus venv Pythons with langchain-core for the adapter test, example,
  and wheel install); `package.json` scripts are unchanged in content
  apart from the new `test:langchain` path.
- The LangChain tool adapter roadmap item is complete; the next top item
  is Webhooks.

## 2026-10-28 — v0.13.0 (LangChain tool adapter, slice 1 — item partial)

- New `langchain_rvn/` Python package wrapping the REST API for Python
  agents. `client.py` is stdlib-only (no third-party deps): `RvnApiClient`
  covers every route — issue, reissue, sub-asset, unique, transfer, list,
  get, simulate, approve, deny, pending, policy get/set, preset list/apply,
  audit, wallet — with quantities as base-unit decimal strings and a DENY
  decision returned as its payload on 403 (other 4xx/5xx raise
  `RvnApiError`). `tools.py` builds 17 LangChain `StructuredTool`s on the
  client, one per route; tool results are JSON strings, held intents come
  back as intent ids (never errors), and API rejections surface as
  `{"error", "status"}` objects. The tools proxy to REST exactly like the
  MCP server does, so the policy engine stays the single enforcement
  point. Importing `langchain_rvn` never requires langchain-core — only
  `get_tools()` does, with a clear install hint otherwise.
- New `langchain_rvn/test_adapter.py` (27 checks, self-booting API on the
  mock node): client ALLOW/DENY/hold flows, tool ALLOW, tool simulate
  DENY, hold → approve → executed with txid, hold → deny, 409 on
  re-approve, 404 on unknown intent, preset list/apply and policy
  round-trip through tools, wallet provisioning, reissue/sub-asset/unique
  through the client, simulate zero-side-effect proof (audit entry count
  unchanged), audit chain valid — all green. The test kills the API's
  whole process group on exit (tsx spawns a node child that otherwise
  survives and leaks mock state into the next run).
- `initialize` now reports server version 0.13.0 (`src/mcp.ts`
  serverInfo, `package.json`, `langchain_rvn/pyproject.toml`).
  Environment note: no `pnpm`
  binary on this VM — verification ran the direct equivalents
  (`node_modules/.bin/tsc`, `node_modules/.bin/tsx`, plus a venv Python
  with langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:langchain` script.
- Remainder of the LangChain item: a worked agent-executor example against
  a real LLM, and PyPI packaging.

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
