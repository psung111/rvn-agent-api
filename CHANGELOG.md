# Changelog

## 2026-11-24 — v0.40.0 (Mainnet guardrail, item complete)

- Mainnet guardrail: "never touch mainnet" no longer rests on the
  operator pointing the API at the right node. New
  `src/rvn/guardrail.ts` — `mainnetAllowedFromEnv()` (only the literal
  `RVN_ALLOW_MAINNET=true` opts in, like `RVN_AUTH_ENABLED`, so a
  half-set env var can never silently open mainnet), `isMainnetChain()`,
  and `checkChainGuardrail()` (throws a named `MainnetGuardrailError`
  on chain `main` without the opt-in). The server asks the node for its
  chain (`getblockchaininfo` via the existing `getInfo()` seam) before
  it listens, and a mainnet chain without the opt-in stops the process
  with exit 1 before any route is served — a misconfigured RPC URL
  fails loudly at startup instead of moving real funds. A node that
  cannot answer leaves the chain unverified (logged loudly) and the API
  still boots: an unreachable node cannot move funds, and submits
  against it fail with 502. The mock reports chain `mock` by default,
  overridable with `MOCK_CHAIN` so the refusal is exercisable without a
  live node; `/v1/health` reports the chain (`chain` / `blocks` /
  `connections`, already spread from `getInfo()` — now also documented
  in the OpenAPI `Health` schema). No new route or tool: the guardrail
  is a boot-time check, and the adapters keep the "cover every route"
  invariant unchanged.
- `initialize` now reports server version 0.40.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README "Going live"
  section gained the guardrail.
- New `pnpm test:guardrail` (`demo/guardrail-test.ts`, 36 checks): env
  parsing incl. the exact-'true' rule, the check function and its error
  message, the mock's `MOCK_CHAIN` handling (default `mock`, `main` /
  `test` pass through, empty/whitespace falls back), and booted-API
  integrations — a mainnet mock without the opt-in exits 1 with
  `/v1/health` never answering and the refusal naming the guardrail and
  `RVN_ALLOW_MAINNET=true` on stderr, the same mock with the opt-in
  boots and reports chain `main`, a testnet mock reports `test`, and
  the default mock reports `mock` with a block height. `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`,
  `pnpm test:hold-aging`, `pnpm test:policy-history`,
  `pnpm test:funding`, `pnpm test:funding-gate`,
  `pnpm test:miner-fee`, `pnpm test:wallet`,
  `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:guardrail` script. No
  local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions); the guardrail needs no migration. The
  real-node `getblockchaininfo` path is the existing `getInfo()` seam,
  unchanged — the mock leg and the booted-API integrations are what
  the suite exercises.
- The mainnet guardrail item is complete; the next top item is
  per-agent wallets.

## 2026-11-23 — v0.39.0 (Miner-fee estimation in the funding check, item complete)

- Miner-fee estimation in the funding check: the v0.36.0 check covered
  the issuance fee but not the variable per-transaction miner fee, so a
  wallet holding exactly the issuance fee simulated as funded and then
  failed at execution. New `estimateFeeRateBaseUnitsPerKb()` seam on
  `RvnNode` — the current fee rate in RVN base units per kilobyte, via
  ravend's `estimatesmartfee` (6-block target) on the real client (null
  on an RPC error, a feerate of -1, an errors list, or a missing
  feerate) and a fixed 10,000 sat/kB default on the mock (override with
  `MOCK_FEE_RATE_BASE_UNITS_PER_KB`; the literal `null` makes it
  unestimable). New in `src/policy/funding.ts` — the per-op
  `ESTIMATED_TX_SIZE_VBYTES` table (issue/sub-asset 500 vB,
  reissue/unique 400 vB, transfer 350 vB — padded estimates for a
  1-input P2PKH asset transaction, so the fee is never understated) and
  `estimateMinerFeeBaseUnits()` (ceiling division, so a partial
  kilobyte still pays the per-byte rate). `checkFunding` asks the node
  for the rate and folds the miner fee into the requirement: a
  supply-creating op needs issuance fee + miner fee in RVN, a transfer
  needs the asset qty plus enough RVN for the miner fee as a second leg
  (checked only once the asset leg passes, so an unfundable transfer
  never spends a node call on the RVN side). The response carries a
  `minerFee` leg (estimated fee, rate, size, and — for transfers — the
  RVN balance behind it). When the node cannot estimate a rate the
  check degrades to the issuance fee / asset qty alone — a throwing,
  malformed, or missing estimate method degrades the same way, never a
  throw and never a flipped ALLOW. The mock debits the miner fee at
  execution too (issuance + miner fee on supply-creating ops, miner fee
  on transfers, checked before any asset moves so a failed call charges
  nothing), so check and execution still agree.
- Adapters keep the "cover every route" invariant with no new tool: the
  MCP / LangChain `simulate_intent` descriptions now name the miner
  fee, and the OpenAPI spec's simulate `funding` schema gained the
  `minerFee` object (the drift test covers it). `initialize` now
  reports server version 0.39.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README funding section rewritten
  around the miner fee.
- New `pnpm test:miner-fee` (`demo/miner-fee-test.ts`, 61 checks): size
  table and fee math incl. the ceiling, checkFunding units incl. the
  RVN-shortfall transfer DENY (`INSUFFICIENT_RVN_BALANCE`) and every
  degradation path (null / throwing / malformed / missing estimate),
  stubbed-fetch `estimatesmartfee` parsing (rate conversion, feerate -1
  / missing feerate / RPC error all -> null), mock debiting incl. a
  wallet with exactly fee + miner fee issuing to 0 RVN and then
  refusing a transfer, and three booted-API integrations — the default
  wallet, a 100 RVN wallet where a reissue at exactly the 100 RVN
  issuance fee now DENYs (the headline case) while a unique still
  ALLOWs, and a 100 RVN + 4,000 sat wallet where the reissue ALLOWs at
  the boundary. The funding, funding-gate, and wallet suites' exact
  RVN-balance expectations were updated for the miner-fee debit
  (a reissue at exactly the balance now DENYs in `pnpm test:funding`
  too). `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`,
  `pnpm test:hold-aging`, `pnpm test:policy-history`,
  `pnpm test:funding`, `pnpm test:funding-gate`,
  `pnpm test:wallet`, `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:miner-fee` script. No
  local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions); the miner-fee seam needs no migration. The
  real-node `estimatesmartfee` path is implemented against the
  documented RPC shape and is NOT verified against a live ravend (no
  live node here) — the mock leg and the stubbed-fetch units are what
  the suite exercises.
- The miner-fee estimation item is complete; the next top item is the
  mainnet guardrail.

## 2026-11-22 — v0.38.0 (Wallet balances endpoint, item complete)

- Wallet balances endpoint: new `GET /v1/wallet/balances` (read-only)
  returns the wallet's RVN balance plus every asset balance it holds,
  so an operator or monitoring agent can see what the wallet can fund
  without simulating an intent for each asset. New
  `listWalletBalances()` seam on `RvnNode` — `{ rvnBaseUnits, assets:
  [{ name, balanceBaseUnits, units }] }`, assets sorted by name, only
  nonzero balances listed (an asset fully transferred out disappears,
  matching ravend's `listmyassets`). The mock sums its ledger balances
  (the same wallet semantics as `getAssetBalance`, so the funding check
  and execution agree); the real client reads `listmyassets` (verbose,
  with the plain-number fallback through `getassetdata` for the units)
  plus `getbalance`. A node that cannot answer is a 502 — there is no
  decision to keep, only the balances, so the funding check's
  `funded: null` degradation does not apply. The read writes nothing
  (no intents, no audit entries), so polling it cannot change what the
  next submit sees; it is a GET, so a `read`-scope key suffices under
  auth.
- Adapters keep the "cover every route" invariant: new
  `get_wallet_balances` MCP tool and LangChain client method + tool
  (`langchain_rvn` now builds 26 tools). The OpenAPI spec gained the
  route plus a `WalletBalances` schema (the drift test covers it).
  `initialize` now reports server version 0.38.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README route table
  gained the row and a new "Wallet balances" section.
- New `pnpm test:wallet` (`demo/wallet-test.ts`, 19 checks): mock units
  (fresh wallet, fee debiting, sorting, units carriage, transfer
  keeping the mock total, unique singleton), real-client units against
  a stubbed fetch (verbose + plain-number entries, zero-balance skip,
  null list, a throwing node rejecting so the route can answer 502),
  and a booted-API integration (fresh wallet, issues appearing with
  balance + units and the RVN fee debited, read purity, and an auth-on
  leg — keyless 401, read-only key 200, write-only key 403, operator
  200). `demo/mcp-smoke.ts` gained section 27 (issue, balances list the
  coin, RVN below the 1,000,000 start, no audit entries) and the
  tools/list check now includes `get_wallet_balances`;
  `pnpm test:langchain` updated (26 tools, client + tool balances
  shape). `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`,
  `pnpm test:hold-aging`, `pnpm test:policy-history`,
  `pnpm test:funding`, `pnpm test:funding-gate`,
  `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:wallet` script. No
  local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions); the balances seam needs no migration. Two
  harness notes: the mcp-smoke section needed a fresh agent (the shared
  smoke agent's per-kind issue bucket from section 18 is exhausted for
  the hour) and the default policy's empty allowlist (the wallet test
  allowlists a provisioned address first, the funding test's pattern);
  four suites crashed in the first back-to-back sweep run (approvals,
  presets, migrations, webhooks) on port collisions between runs and
  all passed on re-run — no product code at fault.
- The wallet balances item is complete; the next top item is miner-fee
  estimation in the funding check.

## 2026-11-21 — v0.37.0 (Funding gate on real submits, item complete)

- Funding gate on real submits: the v0.36.0 funding check lived in
  simulate only, so a real submit that policy-ALLOWed but the wallet
  could not fund went to the node, failed there, and landed as a 502
  with an `EXECUTION_FAILED` audit entry. The gate now runs the same
  `checkFunding` / `applyFunding` check on the real path, in both
  places execution can happen. In `submit()`, a policy ALLOW is
  checked before the decision is stored and audited, so a doomed
  submit becomes a DENY carrying only `INSUFFICIENT_ASSET_BALANCE` /
  `INSUFFICIENT_RVN_BALANCE` (403, with the `funding` object in the
  body) — one `DECISION` audit entry with the final verdict, nothing
  executed, no `EXECUTION_FAILED`. A policy DENY or hold is reported
  exactly as evaluated, and a node that cannot answer (`funded: null`)
  leaves the ALLOW untouched, so execution itself stays the fallback
  verdict. In `resolveApproval()`, a hold that became unfundable while
  it waited is caught after re-evaluation and before execution — 403
  with the funding DENY, audited as a `DECISION` with `atApproval:
  true`, webhook `intent.denied`, and the hold ends instead of failing
  at the node.
- No new route or tool: the MCP / LangChain submit and approve
  descriptions now name the gate, and the OpenAPI spec's issue and
  approve descriptions do too (the transfer route already defers to
  issue's status codes). `initialize` now reports server version
  0.37.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README funding section gained the
  gate.
- New `pnpm test:funding-gate` (`demo/funding-gate-test.ts`, 27 checks):
  funded issue / transfer / sub-asset / unique still execute; an
  over-balance transfer and a never-issued transfer 403 with the
  funding object, debit nothing (the full balance still transfers
  afterwards), are audited as decisions with no `EXECUTION_FAILED`,
  and are not pending (approve -> 409); a funded hold still approves
  and executes; and on a 100 RVN wallet a held issue is refused at
  approval time with the funding DENY audited `atApproval: true`.
  `demo/funding-test.ts` updated: the low-RVN real issue now expects
  the 403 gate refusal instead of the old 502. `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`,
  `pnpm test:hold-aging`, `pnpm test:policy-history`,
  `pnpm test:funding`, `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:funding-gate` script.
  No local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions). One mock-semantics note for future tests:
  the mock's `getAssetBalance` sums balances across all addresses, so
  a transfer can never drain the balance the funding check sees — the
  approval-time gate was proven with the RVN-fee case (a held issue on
  a 100 RVN wallet), not with a drained asset balance.
- The funding-gate item is complete; the next top item is the wallet
  balances endpoint.

## 2026-11-20 — v0.36.0 (Balance-aware simulate, item complete)

- Balance-aware simulate: `simulate` now answers the funding question
  as well as the policy question. New `src/policy/funding.ts` — the
  Ravencoin consensus issuance fees in base units (issue 500 RVN,
  reissue 100 RVN, sub-asset 100 RVN, unique 5 RVN),
  `fundingRequirementFor()` (a transfer needs the wallet to hold qty
  of the asset; a supply-creating op needs the RVN fee), read-only
  `checkFunding()` against the node, and `applyFunding()`, which flips
  a policy-ALLOW the wallet cannot fund into a DENY carrying only
  `INSUFFICIENT_ASSET_BALANCE` / `INSUFFICIENT_RVN_BALANCE`. The check
  runs only on ALLOW: a policy DENY or hold is reported as-is with no
  `funding` object, and a node that cannot answer leaves the ALLOW
  untouched (`funded: null`, error carried) instead of failing the
  simulation. The response carries the `funding` object (asset,
  requiredBaseUnits, balanceBaseUnits — null when the wallet holds
  none of the asset — funded, reasonCode) whenever the check ran.
- New `getAssetBalance` / `getRvnBalance` seam on `RvnNode`. The mock
  sums its ledger balances (its transfer can debit exactly that, so
  check and execution agree) and holds a wallet RVN balance seeded
  from `MOCK_RVN_BALANCE_BASE_UNITS` (default 1,000,000 RVN), debited
  by the issuance fee on every real issue / reissue / sub-asset /
  unique call — a failed call charges no fee, and a low-RVN mock
  refuses an issue the same way the simulation predicts. The real
  client reads `listmyassets` (verbose, with a plain-number fallback
  via `getassetdata`) and `getbalance`, converting decimals to base
  units with the new float-free `decimalToBaseUnits()`. The variable
  miner fee is deliberately not checked.
- No new route or tool: the MCP `simulate_intent` and LangChain
  `simulate_intent` descriptions now name the funding verdict, and the
  OpenAPI spec gained both reason codes plus the `funding` object on
  the simulate response. `initialize` now reports server version
  0.36.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README route table gained the
  balance-aware note and a new "Balance-aware simulate" section.
- New `pnpm test:funding` (`demo/funding-test.ts`, 53 checks): fee
  constants, requirement mapping, decimal conversion, applyFunding
  flip and TTL preservation, checkFunding against the mock incl. a
  throwing node degrading to funded:null, mock fee debiting, and
  booted-API integrations — issue / transfer / sub-asset / unique
  funding reports, over-balance and never-issued transfers DENY,
  policy DENY / hold carry no funding object, zero side effects, and
  a second low-RVN API (100 RVN) proving an issue DENYs at 500 vs
  100 RVN while a unique ALLOWs at 5 RVN and a reissue ALLOWs at
  exactly the balance, with a real issue failing 502 the same way.
  `demo/simulate-test.ts` updated (the transfer ALLOW case now uses
  a really-issued asset; a never-issued transfer DENYs on funding).
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`,
  `pnpm test:hold-aging`, `pnpm test:policy-history`,
  `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:funding` script. No
  local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions). The real-node `listmyassets` /
  `getbalance` path is implemented against the documented RPC shapes
  and is NOT verified against a live ravend (no live node here) — the
  mock leg is what the suite exercises. One real bug caught by the
  test before landing: `decimalToBaseUnits` rejected small RPC
  amounts because `String(0.00000001)` is `'1e-8'` — the converter
  now expands scientific notation before parsing.
- The balance-aware simulate item is complete; the next top items are
  the five newly appended backlog items (funding gate on real
  submits, wallet balances endpoint, miner-fee estimation, mainnet
  guardrail, per-agent wallets).

## 2026-11-19 — v0.35.0 (Policy history + rollback, item complete)

- Policy history + rollback: a PUT or preset apply no longer loses the
  old policy. New `src/policy/history.ts` — `PolicyVersion` (versionId,
  agentId, the snapshotted policy, replacedAtMs, replacedBy `put` /
  `preset` / `rollback`, plus `preset` when the version came from a
  preset apply and `sourceVersionId` when it was replaced by a
  rollback), `policyHistoryLimitFromEnv()` (lenient:
  `RVN_POLICY_HISTORY_LIMIT`, default 10, range 1..100; malformed
  values fall back to the default, never a startup crash),
  `newPolicyVersion()`, and `pruneVersions()` (newest N).
- New `history` / `getVersion` / `recordVersion` seam on `PolicyStore`
  (memory + Postgres): the server archives the agent's own stored
  policy before every replacement — the `*` default is never archived,
  and an agent with no stored policy has nothing to archive — keeping
  the last N versions per agent. Migration `0006_policy_history`
  (`policy_history` table: JSONB policy, `replaced_by` CHECK, agent
  index). New `GET /v1/policies/:agentId/history` (newest first,
  `?limit=` clamped 1..100, same per-agent binding as the other policy
  routes) and `POST /v1/policies/:agentId/rollback` (body `versionId`;
  unknown id 404s, missing id 400s, nothing changes; the restored
  policy becomes live and the policy it replaces is archived as a new
  version with `sourceVersionId`, so a rollback is itself undoable;
  audited as POLICY_REPLACED naming the source version). `/v1/health`
  reports `policyHistory.limit`.
- Adapters keep the "cover every route" invariant: new
  `get_policy_history` / `rollback_policy` MCP tools and LangChain
  client methods + tools (`langchain_rvn` now builds 25 tools).
  `initialize` now reports server version 0.35.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README route table
  gained the history and rollback rows. The OpenAPI spec gained both
  routes plus a `PolicyVersion` schema and a new shared `NotFound`
  response component (the rollback route's 404 previously had no
  component to reference).
- New `pnpm test:policy-history` (`demo/policy-history-test.ts`, 47
  checks): limit parsing (defaults, valid, non-numeric / below-min /
  above-max / fractional fallbacks, max value), version snapshot
  fields (distinct ids, preset / sourceVersionId carriage), prune
  (newest N, under-limit, limit 0 keeps one), and a booted-API
  integration — health reports the limit; fresh history empty; first
  PUT archives nothing (no previous own policy); second PUT archives
  the first policy with source `put`; preset apply archives newest-
  first with source `preset` and the preset name; `?limit=1` caps the
  rows; rollback restores the named version and the live policy reads
  back; the rollback archives the replaced policy with
  `sourceVersionId`, and rolling back that version restores the preset
  policy (rollback is undoable); unknown version 404s, missing
  versionId 400s, both leave the live policy alone; the rollback is
  audited as POLICY_REPLACED with `rollbackFrom`; chain valid. A
  second API with `RVN_POLICY_HISTORY_LIMIT=2` proves the cap (4 PUTs
  → 2 versions, oldest dropped and no longer rollbackable), and an
  auth-on API proves a per-agent key reads only its own history (403
  on another agent's history and rollback). `pnpm test:store` gained
  history-seam checks in the shared suite (both backends);
  `demo/migration-test.ts` and `demo/partition-test.ts` updated for
  migration 0006; `demo/mcp-smoke.ts` gained a policy-history section
  (6 checks) and its openapi/docs version expectations moved to
  0.35.0; `pnpm test:langchain` updated (25 tools, client + tool
  history/rollback shape). `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`,
  `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`, `pnpm test:langchain`
  still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:policy-history`
  script. No local Postgres on this VM, so the Postgres live legs
  were skipped (as in recent sessions); the migration is validated by
  the fake-pool runner in `pnpm test:migrations` and the new SQL by
  the shared store-suite seam checks. Two version stragglers caught
  by the drift checks and fixed in the same session: the partition
  test's hardcoded five-migration expectations and the mcp-auth
  version expectation, both now six migrations / 0.35.0.
- The policy history + rollback item is complete; the next top item
  is balance-aware simulate.

## 2026-11-18 — v0.34.0 (Hold-aging alerts, item complete)

- Hold-aging alerts: a hold that sits unapproved is silent no more. New
  `src/approvals/hold-aging.ts` — `holdAgingConfigFromEnv()` (lenient:
  `RVN_HOLD_ALERT_AFTER_MS`, default 3600000 = 1h, range 1000..7d;
  `RVN_HOLD_ALERT_CHECK_MS`, default 60000, range 1000..1h; invalid
  values fall back to the defaults, never a startup crash),
  `formatAgeMs()` ("45s" / "5m" / "1h 5m" / "2d 3h"),
  `quorumProgressOf()` / `holdAgingInfoOf()` (the n/N of M progress for
  the payload), `isHoldAgingDue()`, and the `checkHoldAging()` sweep
  worker. Once a pending hold is older than the threshold the sweep
  re-notifies the approvers exactly once per hold: a Telegram reminder
  (`notifyAging` on the notifier interface — `formatHoldAgingMessage`
  carries the hold's age and quorum progress, with the same
  Approve/Deny buttons so the approver can act from the reminder) plus
  a new `intent.hold_aging` webhook event (the fifth event type;
  `holdAging: { ageMs, quorum? }` on the payload, subscribable per
  endpoint like the other four). The alert is audited as
  `HOLD_AGING_ALERT` (new audit kind, with ageMs, notified, and the
  quorum counts).
- The "once" is a persisted `Decision.holdAlertedAtMs` flag — both
  stores JSON-serialize decisions, so no migration was needed — and the
  sweep runs on an `unref`'d interval inside the server plus once at
  boot, so a restart re-alerts holds that aged while the server was
  down but never double-fires one that already alerted. A channel
  failure never blocks the other channel, the audit, or the flag; a
  hold whose flag could not be persisted is not counted as alerted, so
  the next sweep retries it instead of silently dropping the alert.
  Approving or denying a hold clears the alert inherently: the decision
  leaves REQUIRE_APPROVAL, so it is no longer pending and the sweep
  never sees it again. `/v1/health` reports `holdAging` (threshold,
  interval, whether any channel is configured). No new route or tool:
  the adapters keep the "cover every route" invariant unchanged.
- New `pnpm test:hold-aging` (`demo/hold-aging-test.ts`, 71 checks):
  config parsing (defaults, valid, non-numeric / below-min / above-max /
  fractional fallbacks, max values), age formatting, due/once-per-hold
  logic (young, old, exactly-at-threshold, already-alerted, ALLOW/DENY
  never due), quorum progress (no quorum, with/without roster, payload
  shape), the aging message (age, quorum line, approve curl), sweep
  worker units (young silent, old alerts once with notify + webhook +
  audit + mark, second sweep silent, quorum counts in webhook and
  audit, notifier failure still webhooks/audits/marks, webhook failure
  still notifies/audits/marks, mark failure not counted and retried),
  and a booted-API integration (health reports the config; a transfer
  hold alerts after 1.5s with one Telegram reminder and one
  `intent.hold_aging` event carrying age >= threshold; the
  `HOLD_AGING_ALERT` audit entry lands; the hold stays pending; no
  second alert on later sweeps; approving clears it; a quorum hold's
  payload and reminder report 0/2, and denying it clears it too).
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi`, `pnpm test:docs`, `pnpm test:langchain`
  still green. `initialize` now reports server version 0.34.0
  (`src/mcp.ts`, `package.json`, `langchain_rvn/pyproject.toml`);
  README gained the hold-aging section and the webhook event list now
  names `intent.hold_aging`.
- Two version stragglers caught by the drift checks and fixed in the
  same session: `src/openapi.ts` `info.version` still said 0.33.0
  (the openapi/docs tests compare it against package.json), and the
  mcp-auth / mcp-smoke version expectations updated to 0.34.0.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:hold-aging` script. No
  local Postgres on this VM, so the Postgres live legs were skipped (as
  in recent sessions); the decision flag needs no migration since both
  stores serialize decisions as JSON. Two test-harness issues fixed
  while verifying (no product code at fault): the mcp-smoke suite
  needs a live API on port 3001 first (its first check is "API is
  running"), and the hold-aging integration initially used a 400ms
  sweep interval below the enforced 1000ms minimum and the transfer
  route's `destination` field (not the `toAddress` alias).
- The hold-aging alerts item is complete; the next top item is policy
  history + rollback.

## 2026-11-17 — v0.33.0 (Generated docs page, slice 2 — item complete)

- OpenAPI spec, slice 2: the contract now renders as a human-readable HTML
  docs page, completing the item. New `src/docs.ts` — pure
  `renderDocsHtml(openApiDocument)`, no dependencies: a single
  self-contained HTML page (inline CSS, no external assets, no
  JavaScript) with the title/version, a link to `/v1/openapi.json`, a
  decision-model section (ALLOW / REQUIRE_APPROVAL / DENY plus the full
  reason-code list from the Decision schema), and every operation grouped
  by tag with its method badge, path, summary, description, parameters
  table, request-body schema, and responses. Schemas render readably:
  `$ref`s inline one level deep (deeper or cyclic refs render by name),
  objects as property lists with required flags, arrays as "array of …",
  enums as their values. Everything from the document is HTML-escaped, so
  a description carrying markup renders as text, never as markup.
- New `GET /v1/docs` (in the spec, so the drift check covers it):
  regenerates the page from the spec on every request, so it can never
  drift from the contract the way a separately maintained docs page
  would; unauthenticated like `/v1/openapi.json` — the docs are the same
  public contract, rendered for reading — and the auth exemption is
  specific (the auth-on test proves `/v1/metrics` still 401s without a
  key). Served as `text/html; charset=utf-8`.
- Adapters keep the "cover every route" invariant: new `get_docs` MCP
  tool (a new `apiText()` fetch path, since the route returns HTML rather
  than JSON) and a LangChain client method + tool (`langchain_rvn` now
  builds 23 tools; the client gained a `_call_text()` transport for the
  HTML route). `initialize` now reports server version 0.33.0
  (`src/mcp.ts`, `package.json`, `langchain_rvn/pyproject.toml`); README
  route table gained the docs row and the OpenAPI contract section now
  names the page, and the auth section names the docs exemption.
- New `pnpm test:docs` (`demo/docs-test.ts`, 15 checks): render units on
  the real spec (title/version, contract link, no external assets, every
  one of the 28 spec operations, all 14 reason codes, the Decision schema
  properties, the decision-model section), hostile-document escaping
  (`<script>` in a description renders as `&lt;script&gt;`, an unknown
  `$ref` renders its name instead of crashing), a minimal doc rendering,
  and a booted-API integration (200 text/html, served page byte-identical
  to the rendered spec, every spec path present, auth-on exemption
  specific). `demo/mcp-smoke.ts` gained a `get_docs` section (5th check
  family: tools/list exposes it, the call returns the HTML at the package
  version with every spec path and the decision model) and its
  `get_openapi` section now asserts `/v1/docs` is in the spec;
  `pnpm test:langchain` updated (23 tools, client + tool docs shape).
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:openapi` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:docs` script. No local
  Postgres on this VM, so the Postgres live legs were skipped (as in
  recent sessions). One harness quirk caught while verifying: a
  verification loop whose `ls` glob matched nothing fed an empty
  argument to `tsx`, which sat at a REPL waiting on stdin — the suites
  were re-run individually with `timeout` guards instead; no product
  code was at fault.
- The OpenAPI spec item is complete; the next top item is hold-aging
  alerts.

## 2026-11-16 — v0.32.0 (OpenAPI spec + drift test, slice 1 — item partial)

- OpenAPI spec, slice 1: the API's machine-readable contract is now
  hand-maintained in `src/openapi.ts` and served verbatim at
  `GET /v1/openapi.json` (OpenAPI 3.0.3, 27 routes: every route,
  decision shape, the full reason-code enum, per-route request/response
  shapes and error statuses — 400/401/403/404/409/410/429/502 where each
  applies). The route is unauthenticated like `/v1/health`: the contract
  is public, so agents can fetch it before they hold a key.
- New `pnpm test:openapi` (`demo/openapi-test.ts`): document-shape checks
  (OpenAPI 3.0.3, `info.version` matches `package.json`, every operation
  has a summary and responses, every tag exists, every `$ref` resolves to
  a declared component, every `{param}` in a path is declared, and the
  reason-code enum covers every code the policy evaluator and the server
  gates can emit); the drift check (the route registrations parsed out of
  `src/server.ts` must be exactly the spec's method+path set, in both
  directions — a route added without a spec entry, or a spec entry for a
  removed route, fails the build); and a booted-API integration (the served
  document is byte-identical to the module, every spec operation is probed
  against the live server and never answers Fastify's route-not-found 404,
  and on a second auth-on API the contract stays open without a key while
  `/v1/metrics` still 401s — the exemption is specific, not auth broken).
- Adapters keep the "cover every route" invariant: new `get_openapi` MCP
  tool (a section 24 in `pnpm mcp-smoke` proves tools/list exposes it and
  the call returns the 3.0.3 contract at the package version with the
  Decision reason-code enum) and a LangChain client method + tool
  (`langchain_rvn` now builds 22 tools). `initialize` now reports server
  version 0.32.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README route table gained the openapi
  row (plus the previously missing sub-asset, unique-asset, and Telegram
  webhook rows) and a new "OpenAPI contract" section, and the auth section
  now names the openapi exemption.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:openapi` script. No
  local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions).
- Remainder of the OpenAPI spec item: generated docs (an HTML docs page
  served from the spec).

## 2026-11-15 — v0.31.0 (Per-key scopes, slice 3 — item complete)

- API-key authentication, slice 3: per-key scopes, completing the item.
  Every issued key now carries an optional scope list — `'read'`
  (GET/HEAD routes) and `'write'` (POST/PUT/DELETE) — so an operator
  can hand out read-only keys for monitoring agents and write-only keys
  for submitters that never need to read. New in `src/auth/keys.ts`:
  the `ApiScope` type, `parseScopes()` (strict: a non-empty array of
  known scopes, deduplicated and returned in canonical order; anything
  else is invalid), `scopesOf()` (lenient: a missing or malformed
  stored list degrades to full access, never a crash — so keys issued
  before v0.31.0 keep working unchanged), and `keyAllowsScope()`;
  `generateApiKey()` takes optional scopes and defaults to full
  access. Migration `0005_api_key_scopes` adds a nullable `scopes
  TEXT[]` column to `api_keys` (NULL = full access, with a CHECK
  keeping garbage out of the column); the Postgres store round-trips
  the array and the memory store carries it on the record.
- The server's auth gate enforces scopes after the admin check: a
  non-operator key without the needed scope gets 403, audited as
  `AUTH_FAILED` with reason `scope_insufficient` (key prefix only,
  never the key). The rule is method-based on purpose: `POST
  /v1/intents/simulate` needs the `write` scope even though it has no
  side effects, so there are no per-route carve-outs to forget. The
  operator key is always full-scope. `POST /v1/admin/api-keys`
  accepts optional `scopes` in the issue body — an invalid list
  (unknown scope, empty array, non-array) is a 400, so a half-valid
  request can never silently mint a full-access key — and listings
  show each key's scopes; the `API_KEY_ISSUED` audit entry records
  them too. No new route or tool: a scoped key's MCP/LangChain submits
  surface the 403 as an error through the existing error paths, while
  its reads work unchanged.
- `pnpm test:auth` extended (now 85 checks): scope parse/resolve
  units (canonical ordering, dedup, empty/unknown/non-array/non-string
  rejections, unscoped and malformed records degrading to full access,
  `generateApiKey` storing the requested scopes, public view carrying
  scopes but no hash) and an auth-on integration — a read-only key
  lists assets and reads its own policy but gets 403 on submit, policy
  PUT, simulate, and approve; a write-only key gets 403 on GETs and
  submits; unknown/empty/non-array scope lists 400 at issue time;
  omitted scopes issue a full-access key that submits; the admin list
  shows each key's scopes; scope denials are audited with reason
  `scope_insufficient`. `pnpm test:store` gained scoped-key round-trip
  checks (scope list preserved, legacy unscoped record reads back
  without scopes) on both backends; `demo/mcp-auth-test.ts` gained a
  read-only MCP section (list and policy read work, issue 403s as an
  error); `demo/migration-test.ts` and `demo/partition-test.ts` updated
  for migration 0005. `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`,
  `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth`, `pnpm test:mcp-auth`,
  `pnpm test:langchain` still green. `initialize` now reports server
  version 0.31.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README route table and auth section
  document scopes.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content. No local Postgres on this VM, so the Postgres
  live legs were skipped (as in recent sessions); the migration is
  validated by the fake-pool runner in `pnpm test:migrations`. One
  pre-existing quirk re-confirmed while verifying: `pnpm mcp-smoke`
  is not idempotent against a reused server — the second run 429s on
  the rate-limit bucket the first run left behind — so it was verified
  once per fresh server, as the documented flow does.
- The API-key authentication item is complete; the next top item is
  the OpenAPI spec.

## 2026-11-14 — v0.30.0 (MCP + LangChain key passthrough, slice 2 — item partial)

- API-key authentication, slice 2: the MCP server and the LangChain
  client pass the key through, so both adapters work against an
  auth-on API. The MCP server reads `RVN_API_KEY` from its
  environment and sends it as `Authorization: Bearer <key>` on every
  proxied request (an empty value counts as unset, so auth-off APIs
  work exactly as before); the startup log says only whether a key is
  set — the key itself never appears in logs. A 401 from the API now
  surfaces as `isError` on every tool, including the three submit
  tools (`issue_asset`, `reissue_asset`, `transfer_asset`) that
  previously treated only 403/429 as errors, so a missing or revoked
  key is loud instead of a success-shaped payload.
- The LangChain client takes an `api_key` argument (an explicit key
  wins over the `RVN_API_KEY` env var, which is the fallback; an
  empty string means no key) and sends the same Bearer header on
  every request. A 401 raises `RvnApiError` with status 401 — the
  submit routes' 403 pass-through is untouched, so DENY decisions
  still return their payload — and the LangChain tools turn the 401
  into `{"error", "status": 401}`. No new tools: the key rides the
  existing client and proxies.
- `initialize` now reports server version 0.30.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README gained the
  `RVN_API_KEY` config for the MCP server and the `api_key` example
  for the LangChain client, and the auth section no longer says the
  adapters need auth off (it also corrects the stale "17 tools" to
  21).
- New `pnpm test:mcp-auth` (`demo/mcp-auth-test.ts`, 14 checks):
  boots its own auth-on API, issues a per-agent key through the
  operator key, and proves the keyed MCP server lists assets, issues
  as its own agent (ALLOW), and 403s as another agent (policy read
  included); a keyless MCP server 401s on list/issue/transfer, a
  wrong-key server 401s on list, and the keyed server's stderr is
  asserted to never contain the raw key; the audit chain stays
  valid. `pnpm test:langchain` gained an auth-on section (keyless
  and wrong-key clients raise 401, health stays open, keyed client
  issues ALLOW, env-var pickup with explicit-argument override,
  agent-mismatch 403 payload, keyed tool issue, keyless tool 401).
  `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:auth` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:mcp-auth` script. No
  local Postgres on this VM, so the Postgres live legs were skipped
  (as in recent sessions).
- Remainder of the API-key authentication item: per-key scopes (e.g.
  read-only keys).

## 2026-11-13 — v0.29.0 (API-key authentication, slice 1 — item partial)

- API-key authentication, slice 1: the core auth — key issuance and
  verification, the REST gate, per-agent binding, and the admin surface.
  New `src/auth/keys.ts`: `generateApiKey()` issues `rvn_` + 32 random
  hex chars (128 bits of entropy) and stores only the SHA-256 hash, so
  the raw key is shown once at issue time and can never be recovered
  from the record; `verifyApiKey()` compares hashes in constant time
  (a revoked record never verifies, a malformed stored hash never
  throws); `authConfigFromEnv()` turns auth on when
  `RVN_AUTH_ENABLED=true` or when `RVN_OPERATOR_API_KEY` is set — a
  shorter-than-16-characters operator key is ignored entirely rather
  than becoming a weak credential; `verifyOperatorKey()` verifies the
  env-seeded operator key in memory; `parseBearerHeader()` extracts
  the token from `Authorization: Bearer <key>`; `publicApiKey()`
  strips the hash for listings.
- New `apikeys` seam on the `Store` interface — issue / getByHash /
  getById / list / revoke — implemented on the memory store and on
  Postgres behind migration `0004_api_keys` (`id`, `agent_id`,
  `key_hash` unique, `key_prefix`, `created_at_ms`, `revoked_at_ms`).
  Revocation sets the timestamp instead of deleting the row, so a
  revoked key stays auditable and its hash can never be re-issued as a
  live key by accident; `getByHash` returns revoked records unchanged
  and the verifier is what refuses them. The memory store's revoke
  keeps the original revocation time on a second call, matching the
  Postgres `UPDATE ... WHERE revoked_at_ms IS NULL`.
- The server gates the REST surface in an `onRequest` hook: with auth
  on, every `/v1` route except `/v1/health` (liveness) and
  `/v1/telegram/webhook` (which has its own Telegram secret check)
  requires a Bearer key — the env-seeded operator key, or an issued
  key resolved by hash from the store. A missing or wrong key gets 401
  and the attempt is audited as `AUTH_FAILED` (new audit kind) with
  the key prefix only, never the key itself. The admin surface
  additionally requires the operator key (403 otherwise, also
  audited). A non-operator key may only act as its own agent: submits
  (`issue` / `reissue` / `subasset` / `unique` / `transfer` /
  `simulate`) and the agent-scoped reads and writes (policies,
  ratelimit, anomaly) return 403 on a mismatch — audited as
  AUTH_FAILED with reason `agent_mismatch` — and an omitted `agentId`
  defaults to the key's agent instead of `agent-1`. The operator key
  may act as any agent. Approve/deny and the global reads (assets,
  pending, audit, metrics, archive) need any valid key, with no agent
  binding in this slice.
- Admin surface (operator key only): `POST /v1/admin/api-keys`
  (`{ agentId }` → `{ key, record }`, audited as `API_KEY_ISSUED`,
  new audit kind), `GET /v1/admin/api-keys` (optional `?agentId=`,
  public view only — id, agent, prefix, timestamps, revocation — no
  hash, no raw key), `POST /v1/admin/api-keys/:id/revoke` (audited as
  `API_KEY_REVOKED`, new audit kind; revocation takes effect
  immediately — the next request with that key gets 401; unknown id
  404s; a second revoke keeps the original time). `/v1/health`
  reports `auth: { enabled, operatorKeyConfigured, keys }` (live-key
  count, best-effort so a store read failure never takes the liveness
  check down). With auth off — the default — the hook is a no-op and
  the identity is the operator, so the demo loop and every existing
  suite run exactly as before.
- `initialize` now reports server version 0.29.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README route table
  gained the admin rows and a new API-key authentication section.
- New `pnpm test:auth` (`demo/auth-test.ts`, 55 checks): key/hash/
  verify/Bearer/env units (format, uniqueness, hash-only storage,
  wrong/revoked/malformed keys, short operator key ignored, operator
  verification, public view carries no hash); an auth-off integration
  (health reports disabled, admin issues and submits work without a
  key); and an auth-on integration (health stays open and reports
  enabled with the live-key count, 401 without a key or with a wrong
  key, metrics gated, Telegram webhook exempt, operator issues a
  per-agent key shown once, listing carries the prefix but no hash,
  agent key submits as its own agent and defaults to it when agentId
  is omitted, 403 acting as another agent or on the admin surface,
  operator acts as any agent, revoke → immediate 401, revoked key
  stays listed with its time, unknown revoke 404s, missing agentId
  400s, AUTH_FAILED / API_KEY_ISSUED / API_KEY_REVOKED audit entries,
  chain valid). `pnpm test:store` gained api-key seam checks (both
  backends; Postgres leg skipped here, no local Postgres) and its
  TRUNCATE now includes `api_keys`; `demo/migration-test.ts` and
  `demo/partition-test.ts` updated for migration 0004. `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics`,
  `pnpm test:quorum`, `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:auth` script. No local
  Postgres on this VM, so the Postgres live legs were skipped (as in
  recent sessions); the migration is validated by the fake-pool runner
  in `pnpm test:migrations`. One pre-existing quirk confirmed while
  verifying: `pnpm mcp-smoke` is not idempotent against a reused
  server — a second run 429s on the rate-limit bucket the first run
  left behind — so it was verified once per fresh server, as the
  documented flow does.
- Remainder of the API-key authentication item: the MCP server and
  LangChain client passing the key through, and per-key scopes (e.g.
  read-only keys).

## 2026-11-12 — v0.28.0 (Approver roster for multi-approver quorum, slice 2 — item complete)

- Approver roster (M) for multi-approver quorum, completing the item:
  a policy-defined set of approver identities, so only roster members
  count toward quorum and a pending hold reports n/N of M. New optional
  policy field `quorumApprovers` (string array). `normalizeRoster()` in
  `src/policy/quorum.ts` parses it leniently for stored policies
  (trim, drop empty/non-string entries, dedup; a non-array or
  all-empty value means no roster, never a crash), and
  `validateQuorumFields()` enforces it strictly on PUT and preset
  overrides — a roster with no count or no threshold is half-configured,
  empty/non-string entries are rejected, and a required count above the
  roster size is rejected (a quorum that can never be met is a config
  error, not a policy). A quorum without a roster keeps the v0.27.0
  behavior: any N distinct approvers count.
- `evaluateIntent` snapshots the roster onto the decision
  (`Decision.quorumApprovers`) with the count, so the stored decision is
  the authority at approval time: a policy change after the hold can
  neither add nor remove approvers from that hold. `resolveApproval`
  rejects a non-roster approver with 403 (the count does not move,
  nothing is recorded) and reports `approversTotal: M` on every quorum
  response — the 202 partial approval, the 202 already-counted reply,
  the 403, and the final 200 — so a pending hold reports n/N of M
  through its decision, pending list included, with no route change.
  A deny by any single approver still ends a hold outright, roster or
  not: the roster gates approvals toward quorum, not the deny. The
  Telegram webhook shares the same path, so a tap from a non-roster
  `telegram:<name>` identity gets the not-on-the-roster toast and the
  hold message stays up. `simulate` reports the roster with zero side
  effects, like every other gate.
- Adapters keep the "cover every route" invariant with no new tool:
  the MCP `approve_intent` / `set_policy` / `pending_intents` and
  LangChain `approve_intent` descriptions now name the roster, and
  `applyPreset` accepts `quorumApprovers` as an override.
  `initialize` now reports server version 0.28.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README approve row
  gained the roster note.
- New `pnpm test:quorum` coverage (now 93 checks): roster
  normalization and strict-validation units (trim/dedup/drop-empties,
  non-array and all-empty degrade to no roster, count above roster
  size / roster-only / empty / non-string entries all rejected); PUT
  400s for the roster cases that leave the stored policy untouched;
  preset overrides (count above roster rejected, valid roster
  applies); and a full roster integration — a hold snapshots M=3
  with quorumRequired 2, pending reports 0/2 of 3, an outsider gets
  403 with the count unmoved, a roster member approves 1/2 of 3, a
  repeat still counts 1, a policy roster swapped after the hold
  cannot approve it (the stored roster governs), the second roster
  member executes 2/2 of 3, a non-roster deny still ends a hold, and
  simulate reports the roster. `demo/mcp-smoke.ts` gained a roster
  section (5 checks). `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`,
  `pnpm test:subasset`, `pnpm test:unique`, `pnpm test:presets`,
  `pnpm test:anomaly`, `pnpm test:store`, `pnpm test:archive`,
  `pnpm test:migrations`, `pnpm test:partition`,
  `pnpm test:webhooks`, `pnpm test:ratelimit`,
  `pnpm test:metrics`, `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content.
- The multi-approver quorum item is complete; the next top item is
  API-key authentication (first of five newly appended backlog items).

## 2026-11-11 — v0.27.0 (Multi-approver quorum, slice 1 — item partial)

- Multi-approver quorum for high-value holds, slice 1: policy fields
  plus approval counting on the HTTP approve path (the Telegram button
  path shares the same resolution code, so distinct-approver counting
  rides along). New optional policy fields — `quorumApprovals`
  (distinct approvers required, integer >= 2), `quorumAboveIssueQtyBaseUnits`
  and `quorumAboveTransferQtyBaseUnits` (non-negative integer decimal
  strings): intents whose qty sits above the applicable threshold need
  N distinct approvers instead of one; below it a single approver
  still suffices, so every existing flow is unchanged.
- New `src/policy/quorum.ts`, following the established lenient/strict
  split: `quorumConfigFromPolicy()` resolves a stored policy leniently
  (quorum is active only when the count is an integer >= 2 AND at least
  one threshold parses — a count of 1, a missing side, or a malformed
  threshold degrades to no quorum, never a crash), and
  `validateQuorumFields()` rejects strictly on PUT and preset
  overrides (count below 2, a count with no threshold, a threshold
  with no count, malformed/negative thresholds all 400, nothing
  stored). `applyPreset` accepts all three fields as overrides with
  the same checks.
- `evaluateIntent` marks quorum holds on the decision itself
  (`Decision.quorumRequired: N`): the count is attached to every
  REQUIRE_APPROVAL decision whose qty is above the quorum threshold,
  whatever else held it, and a would-be-ALLOW intent above the
  threshold is held with reason code `QUORUM_REQUIRED` instead of
  being allowed. The stored decision is the authority at approval
  time, so a policy change after the hold can neither silently drop
  nor add a quorum.
- `resolveApproval` counts distinct approver identities on the stored
  decision (`Decision.approvals`, persisted with the decision in both
  the memory and Postgres stores, so a restart cannot lose the count):
  the first approval returns 202 with `approvalsReceived` /
  `approvalsRequired` and executes nothing; the same approver approving
  again returns 202 with `alreadyCounted: true` and the count
  unchanged; the Nth distinct approver re-evaluates and executes
  (200 + txid, with the full count in the response). A deny by any
  single approver still ends the hold outright. Each recorded approval
  is audited as an `APPROVAL` entry carrying the running count. The
  Telegram webhook answers a partial approval with an n/N toast and
  leaves the hold message up (only a final 200 edits it); a tap from
  the same `telegram:<name>` identity counts once, so one person
  tapping Approve twice cannot meet a quorum alone. `simulate`
  reports the quorum decision with zero side effects, like every other
  gate.
- Adapters keep the "cover every route" invariant with no new tool:
  the MCP `approve_intent` and LangChain `approve_intent` already
  proxy the route (a 202 is a success, not an error), and their
  descriptions now name the quorum progress. `initialize` now reports
  server version 0.27.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README approve row gained the
  quorum note.
- New `pnpm test:quorum` (`demo/quorum-test.ts`, 57 checks):
  parse/validate units (lenient degradation, strict rejections incl.
  half-configured quorums); PUT 400s that leave the stored policy
  untouched and the same validation on preset overrides; a
  below-threshold hold executing on one approval with no
  `quorumRequired`; a quorum hold — 202 with 1/2 and no txid, still
  pending, no supply created, repeat approval still 1, second distinct
  approver executes 2/2 and the hold leaves pending, re-approve 409;
  a single deny ending a quorum hold; a transfer above the transfer
  quorum threshold (but below the approval threshold) holding with
  `QUORUM_REQUIRED` and executing on the second approver; simulate
  reporting the quorum decision with no audit entries and no pending
  intent, and a 404 on approving the simulated id; chain valid at the
  end. `demo/mcp-smoke.ts` gained a quorum section (5 checks: set
  policy, hold with quorumRequired 2, first approval 202 1/2, repeat
  still 1, second approver executes). `pnpm test:langchain` updated
  (21 tools, approve docstring) — all green. `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`,
  `pnpm test:partition`, `pnpm test:webhooks`,
  `pnpm test:ratelimit`, `pnpm test:metrics` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:quorum` script.
- Remainder of the multi-approver quorum item: an approver roster (M)
  — a policy-defined set of approver identities, so only roster
  members count toward quorum.

## 2026-11-10 — v0.26.0 (Ops metrics endpoint, item complete)

- New `GET /v1/metrics` (JSON, no new deps): decision counts by kind
  and reason code, rate-limit 429s by agent and kind, webhook delivery
  successes/failures by endpoint, approval hold age (oldest pending),
  and the store backend — so an operator can monitor the API without
  scraping the audit log. Read-only and unauthenticated like
  `/v1/health` (localhost-only bind is the existing posture); the
  payload carries no policy internals and no secrets (agent ids, intent
  kinds, reason codes, webhook endpoint URLs, counts only).
- New `src/ops/metrics.ts`: pure `computeMetrics()` aggregates the
  retained audit chain at request time, so the counts survive a restart
  and describe exactly what the durable record says. DECISION entries
  count only when their detail kind is a real decision kind (ALLOW /
  REQUIRE_APPROVAL / DENY) — the POLICY_REPLACED entries written by
  policy PUTs and preset applies are excluded. Approval-time
  re-evaluation DENYs are counted (they are DECISION entries); an
  approval itself writes no DECISION entry, so approving a hold changes
  nothing. Rate-limit 429s come from the RATE_LIMIT_EXCEEDED reason
  code, grouped by agent and intent kind. Webhook entries group by
  endpoint URL; entries written before v0.26.0 carry no endpoint and
  count under `unknown`. Counts cover the retained chain only — archived
  slices live in the archive files — and the response reports the
  retained length as `audit.entries`, plus `chainValid`, `uptimeSeconds`,
  and `generatedAtMs`. Malformed detail (non-string kind, non-array
  reasonCodes, missing op/endpoint) degrades to skip/unknown, never a
  crash. The route reads `store.audit.all()` + `store.intents.pending()`
  and writes nothing, so polling it cannot change what the next submit
  sees.
- New `AuditStore.all()` seam (both backends; `AuditLog.all()` in the
  memory store): every retained entry ascending by seq, for the metrics
  aggregation.
- Per-endpoint webhook audit (the metrics need it): `WebhookDispatcher`
  gained `deliverDetailed()` returning the delivered/failed URL lists
  per event; the shared per-endpoint retry loop is now `attemptEndpoint`
  (used by the unchanged `deliver()`, which keeps its throw-after-
  retries and attempted-count behavior). A sender that throws marks
  that endpoint failed in `deliverDetailed()` instead of aborting the
  fan-out. The server now audits one WEBHOOK_DELIVERY /
  WEBHOOK_DELIVERY_FAILED entry per endpoint with `{ event, endpoint }`
  — a partial failure records both the delivered and the failed
  endpoints, where the old code audited a single FAILED entry for the
  whole event and lost the successes.
- Adapters keep the "cover every route" invariant: new `get_metrics`
  MCP tool and LangChain client method + tool (`langchain_rvn` now
  builds 21 tools). `initialize` now reports server version 0.26.0
  (`src/mcp.ts`, `package.json`, `langchain_rvn/pyproject.toml`);
  README route table gained the metrics row.
- New `pnpm test:metrics` (`demo/metrics-test.ts`, 30 checks):
  `computeMetrics` units (empty chain, decision/reason counts,
  POLICY_REPLACED and non-string-kind exclusion, 429s by agent and
  kind, webhook counts by endpoint incl. the `unknown` bucket, oldest-
  hold age math, malformed detail, store/chain/uptime pass-through);
  a booted-API integration (fresh zeros; ALLOW/DENY/hold counted with
  the right reason codes; policy PUTs do not inflate the counts;
  approving the hold writes no DECISION entry; a 1-op bucket produces
  exactly one 429 counted by agent and kind; two consecutive reads
  report the same audit entry count); and a stub-receiver integration
  (decided + executed delivered per endpoint URL, then 2 failed after
  the receiver goes down, delivered count unchanged). `pnpm test:store`
  gained `all()` checks in the shared suite (both backends);
  `demo/mcp-smoke.ts` gained a metrics section (2 checks);
  `pnpm test:langchain` updated (21 tools, client + tool metrics
  shape). `pnpm demo`, `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:archive`, `pnpm test:migrations`, `pnpm test:partition`,
  `pnpm test:webhooks`, `pnpm test:ratelimit`,
  `pnpm test:langchain` still green.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:metrics` script.
- The ops metrics roadmap item is complete; the next top item is
  multi-approver quorum.

## 2026-11-09 — v0.25.0 (Audit retention & partitioning, slice 2 — item complete)

- Monthly partitioning of `audit_entries` in Postgres, the remainder of
  the audit retention item. New migration
  `0003_audit_entries_partitioning`: a table-rebuild migration that
  creates `audit_entries_new` as `PARTITION BY RANGE (at_ms)` (one
  partition per UTC calendar month, `audit_entries_YYYY_MM`), creates
  one partition per month holding data plus the current month and the
  next two, copies every row, drops the old table, and renames — all
  inside the migration transaction, so a failure rolls the whole
  rebuild back. The primary key becomes `(seq, at_ms)`: a partitioned
  table's PK must include the partition key, so the database no longer
  enforces seq uniqueness on its own — seq stays unique in practice
  because the API assigns it serially under the advisory lock in
  `PostgresAuditStore.append`, and the chain hash remains the real
  integrity check (`verifyChain` recomputes every hash). The
  non-unique `audit_entries_intent_id` index is recreated unchanged.
- New `src/store/partitions.ts`: `auditPartitionFor(atMs)` computes a
  month's UTC bounds (`Date.UTC`, so it is timezone-independent) and
  `auditPartitionDdl()` renders the `CREATE TABLE IF NOT EXISTS ...
  PARTITION OF audit_entries` statement (the name is built from
  integers only, so interpolating it is safe). `PostgresAuditStore.append`
  runs that DDL inside its advisory-locked transaction before inserting,
  so a month boundary can never fail an append — appends are serialized,
  so two appends can never race the CREATE, and `IF NOT EXISTS` makes
  it a no-op in the common case. `/v1/health` now reports
  `audit.partitioned` (true once migration 0003 has applied; false on
  the memory store).
- New `pnpm test:partition` (`demo/partition-test.ts`, 32 checks):
  month-bound unit checks (exact month start, last millisecond of a
  month, Dec→Jan rollover, leap February, epoch, exact DDL text), the
  shipped-migration checks, a fake-pool runner apply, and a live leg
  against a real Postgres — a scratch database built on the old schema
  (0001+0002) with audit rows from past months, then connected via
  `PostgresStore.connect` so 0003 rebuilds it: every row survives in
  its own month's partition, the table reports as partitioned, the
  chain verifies, a store append lands in the current month's
  partition, a far-future month refuses a raw insert until the
  partition DDL runs, and prune still works on the partitioned table.
  `demo/migration-test.ts` updated for three migrations (including the
  gap test, which now uses a 0004 stand-in). `pnpm demo`,
  `pnpm mcp-smoke`, `pnpm test:approvals`,
  `pnpm test:telegram-callback`, `pnpm test:simulate`,
  `pnpm test:reissue`, `pnpm test:subasset`, `pnpm test:unique`,
  `pnpm test:presets`, `pnpm test:anomaly`, `pnpm test:store`,
  `pnpm test:webhooks`, `pnpm test:ratelimit`,
  `pnpm test:langchain` still green — and `pnpm test:store`'s
  Postgres leg ran live for the first time on this VM (a local
  PostgreSQL 16 was installed from cached packages for the session).
  `initialize` now reports server version 0.25.0 (`src/mcp.ts`,
  `package.json`, `langchain_rvn/pyproject.toml`); README persistence
  section gained the partitioning note.
- One bug caught by a live dry run and fixed before landing: month
  arithmetic on `timestamptz` preserves local wall time, so in a
  non-UTC session timezone a DST transition drifts the month starts
  and skips months entirely — the first dry run created partitions
  whose bounds jumped from Oct 31 to Dec 1 01:00 UTC, never created
  2025_11, and the copy failed with "no partition of relation found
  for row". The migration now iterates on `timestamp` (a UTC wall
  clock; `extract(epoch FROM timestamp)` reads it as UTC, verified
  live under `TimeZone = 'America/Los_Angeles'`), and the dry run was
  re-run clean.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:partition` script.
- The audit retention & partitioning roadmap item is complete; the
  next top item is the ops metrics endpoint.

## 2026-11-08 — v0.24.0 (Audit archive + retention pruning, slice 1)

- Audit retention, slice 1 of the audit retention & partitioning item:
  the archive/prune machinery is in place; monthly Postgres
  partitioning (a table-rebuild migration) is the remainder. New
  `src/audit/archive.ts`: `buildArchive()` exports a contiguous slice
  of the hash chain as a self-contained document — the entries, the
  seq range, the first entry's `prevHash`, and the last entry's hash
  (the head hash) — refusing empty, non-contiguous, or internally
  broken slices; `verifyArchive()` re-verifies a document (header vs
  entries + internal chain, returning the first broken seq or -1);
  `verifyContinuity()` proves the retained chain starts exactly where
  the archive ended (its oldest entry links to the head hash at
  `lastSeq + 1`), so the full history — archive + retained chain —
  verifies end to end across the boundary.
- Retention config from the environment, lenient like the webhook and
  rate-limit config: `RVN_AUDIT_RETENTION_DAYS` (integer 1–3650,
  default 90; malformed values fall back to 90) and
  `RVN_AUDIT_ARCHIVE_DIR` (default `audit-archives/`; empty falls back
  to the default). `/v1/health` reports both.
- `verifyChain` takes an optional anchor prevHash, so a pruned chain
  still verifies: the anchor is the oldest retained entry's prevHash
  (the archived head hash), and for an unpruned chain that is
  `GENESIS`, so behavior is unchanged. Hash recomputation still covers
  every retained entry, so anchoring never hides tampering inside the
  retained slice.
- New `AuditStore` seam — `oldest()`, `beforeMs(cutoffMs, limit?)`
  (ascending, capped at 10,000 by default), and `prune(beforeSeq)` —
  implemented on both backends. Prune always keeps the newest entry as
  the chain anchor for future appends (Postgres: `seq < (SELECT
  MAX(seq) ...)`), and an append after a prune chains onto that anchor
  with the next seq.
- New `POST /v1/audit/archive` (body: optional `beforeMs` epoch ms;
  omitted means "older than the retention policy"). At most 10,000
  entries per call (`moreMayRemain` says to call again). The archive
  file (`audit-archive-<firstSeq>-<lastSeq>.json`) is written before
  anything is pruned, so a failed write prunes nothing; a broken chain
  refuses with 500 instead of archiving history away. The proof is
  recorded in-chain as a new `AUDIT_ARCHIVED` audit entry
  (firstSeq/lastSeq/headHash/archiveFile). Entries appended
  concurrently get a seq above the archived range, so they survive the
  prune and are picked up by the next run — nothing is pruned that the
  archive does not contain.
- Adapters keep the "cover every route" invariant: new `archive_audit`
  MCP tool and LangChain client method + tool (`langchain_rvn` now
  builds 20 tools). One bug caught by the adapter test: the Python
  client first sent `before_ms` on the wire while the server reads
  `beforeMs` — it now sends the camelCase key.
- New `pnpm test:archive` (`demo/archive-test.ts`, 57 checks):
  archive/continuity/config unit checks, the memory-store prune seam
  (prune keeps the anchor, append chains on, verify stays green), and
  a booted-API integration (400 on a bad cutoff, no-op on an ancient
  cutoff, a real archive — file written and verifying, 4 of 5 entries
  pruned, chain valid, continuity holds against the live tail, the
  `AUDIT_ARCHIVED` proof entry). `pnpm test:store` gained prune
  checks in the shared suite (both backends); `demo/mcp-smoke.ts`
  gained an archive section (ancient cutoff: archives nothing, writes
  nothing); `pnpm test:langchain` updated (20 tools, client + tool
  archive shape). `pnpm demo`, `pnpm mcp-smoke`,
  `pnpm test:approvals`, `pnpm test:telegram-callback`,
  `pnpm test:simulate`, `pnpm test:reissue`, `pnpm test:subasset`,
  `pnpm test:unique`, `pnpm test:presets`, `pnpm test:anomaly`,
  `pnpm test:store`, `pnpm test:webhooks`, `pnpm test:ratelimit`,
  `pnpm test:migrations` still green. `initialize` now reports server
  version 0.24.0 (`src/mcp.ts`, `package.json`,
  `langchain_rvn/pyproject.toml`); README route table gained the
  archive row; `audit-archives/` added to `.gitignore`.
- Environment note: no `pnpm` binary on this VM — verification ran the
  direct equivalents (`node_modules/.bin/tsc`,
  `node_modules/.bin/tsx`, plus a fresh venv Python with
  langchain-core for the adapter test); `package.json` scripts are
  unchanged in content apart from the new `test:archive` script.
- Remainder of the audit retention & partitioning item: monthly
  declarative partitioning of `audit_entries` in Postgres.

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
