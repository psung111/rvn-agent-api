-- 0002_decisions_kind_index: expression index on the decision kind, so the
-- pending-intents lookup (decisions filtered by decision->>'kind' =
-- 'REQUIRE_APPROVAL', see PostgresIntentStore.pending) uses an index scan
-- instead of scanning the whole decisions table as held intents accumulate.
CREATE INDEX IF NOT EXISTS decisions_kind ON decisions ((decision->>'kind'));
