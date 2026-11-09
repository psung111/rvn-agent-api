-- 0003_audit_entries_partitioning: convert audit_entries to a monthly
-- range-partitioned table on at_ms (epoch ms, UTC months), so old months
-- can be dropped or archived as whole partitions and time-range reads
-- (beforeMs, the retention archive scan) prune partitions instead of
-- scanning the whole chain.
--
-- A partitioned table's primary key must include the partition key, so the
-- PK becomes (seq, at_ms). seq stays unique in practice — the API assigns
-- it serially under an advisory lock (see PostgresAuditStore.append) — but
-- the database no longer enforces seq uniqueness on its own; the chain
-- hash is the real integrity check (verifyChain recomputes every hash).
--
-- The rebuild runs inside the migration transaction: build the partitioned
-- table, create one partition per month holding data (plus the current
-- month and the next two, so inserts never wait on DDL), copy the rows,
-- drop the old table, rename. The API also creates the entry's month on
-- demand at append time (see PostgresAuditStore.append), so a month
-- boundary can never fail an insert. The backfill loop is capped at 120
-- months: a chain spanning more than that fails the migration loudly (and
-- rolls back) instead of creating an unbounded number of partitions.

CREATE TABLE audit_entries_new (
  seq       BIGINT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  at_ms     BIGINT NOT NULL,
  kind      TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  detail    TEXT NOT NULL,
  PRIMARY KEY (seq, at_ms)
) PARTITION BY RANGE (at_ms);

DO $$
DECLARE
  -- timestamp (no tz) throughout: month arithmetic on timestamptz
  -- preserves local wall time, so in a non-UTC session timezone a DST
  -- transition drifts the month starts and skips months entirely
  -- (verified live: a timestamptz loop skipped 2025_11). A timestamp
  -- is a UTC wall clock here, and extract(epoch FROM timestamp) reads
  -- it as UTC, so the bounds are exact in every session timezone.
  first_month timestamp;
  last_month  timestamp;
  m           timestamp;
  guard       int := 0;
BEGIN
  -- Earliest month holding data, truncated in UTC; an empty table starts
  -- at the current month. at_ms is epoch milliseconds.
  first_month := date_trunc('month', COALESCE(
    to_timestamp((SELECT MIN(at_ms) FROM audit_entries) / 1000.0),
    now()
  ) AT TIME ZONE 'UTC');
  -- Partitions through the end of next month, so the current month and
  -- the next two are covered.
  last_month := date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months';
  m := first_month;
  WHILE m < last_month AND guard < 120 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_entries_new FOR VALUES FROM (%s) TO (%s)',
      'audit_entries_' || to_char(m, 'YYYY_MM'),
      (extract(epoch FROM m) * 1000)::bigint,
      (extract(epoch FROM (m + interval '1 month')) * 1000)::bigint
    );
    m := m + interval '1 month';
    guard := guard + 1;
  END LOOP;
  IF guard >= 120 THEN
    RAISE EXCEPTION 'audit_entries spans more than 120 months; refusing to partition';
  END IF;
END $$;

INSERT INTO audit_entries_new (seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail)
  SELECT seq, prev_hash, hash, at_ms, kind, intent_id, agent_id, detail FROM audit_entries;

DROP TABLE audit_entries;

ALTER TABLE audit_entries_new RENAME TO audit_entries;

CREATE INDEX IF NOT EXISTS audit_entries_intent_id ON audit_entries (intent_id);
