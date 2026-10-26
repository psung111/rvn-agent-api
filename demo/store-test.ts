/**
 * store-test: checks for the persistence seam (src/store).
 *
 *  pnpm test:store
 *
 * Runs the same suite against:
 *   1. the in-memory store (always)
 *   2. the Postgres store, when TEST_DATABASE_URL (or RVN_DATABASE_URL) is
 *      set — skipped otherwise, since CI/dev machines may not run Postgres
 *   3. storeFromEnv fallback: an unreachable database URL must degrade to
 *      the in-memory store instead of crashing startup
 *
 * The suite covers: policy get/set round-trip, intent + decision put/get,
 * pending() listing and expiry, the rolling issue ledger, audit chain
 * append/verify, and hash-chain tamper detection.
 */
import { Pool } from 'pg';
import { verifyChain, type AuditEntry } from '../src/audit.js';
import { defaultPolicy, type Decision, type RvnIntent, type RvnPolicy } from '../src/policy/index.js';
import { MemoryStore, PostgresStore, storeFromEnv, type Store } from '../src/store/index.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

function makeIntent(id: string, agentId = 'store-agent'): RvnIntent {
  return {
    id,
    agentId,
    kind: 'transfer_asset',
    assetName: 'STORECOIN',
    qtyBaseUnits: '100',
    destination: 'RXdest1111111111111111111111111',
    requestedAtMs: Date.now(),
  };
}

function makeDecision(intent: RvnIntent, kind: Decision['kind'] = 'REQUIRE_APPROVAL', ttlMs = 60_000): Decision {
  const now = Date.now();
  return { intentId: intent.id, agentId: intent.agentId, kind, reasonCodes: ['WITHIN_POLICY'], decidedAtMs: now, expiresAtMs: now + ttlMs };
}

async function runSuite(label: string, store: Store) {
  console.log(`--- ${label} (${store.kind}) ---`);

  // Policies: default seeded, set/get round-trip.
  const seeded = await store.policies.get('*');
  check('default policy seeded', seeded?.agentId === '*' && seeded.version === 1, seeded);
  const custom: RvnPolicy = { ...defaultPolicy('agent-7'), maxIssueQtyBaseUnits: '42' };
  await store.policies.set(custom);
  const fetched = await store.policies.get('agent-7');
  check('policy set/get round-trip', fetched?.maxIssueQtyBaseUnits === '42', fetched);
  check('unknown agent policy is undefined', (await store.policies.get('nope')) === undefined);

  // Intents + decisions.
  const intent = makeIntent(`${label}-intent-1`);
  await store.intents.putIntent(intent);
  const decision = makeDecision(intent);
  await store.intents.putDecision(intent.id, decision);
  check('intent put/get', (await store.intents.getIntent(intent.id))?.assetName === 'STORECOIN');
  check('decision put/get', (await store.intents.getDecision(intent.id))?.kind === 'REQUIRE_APPROVAL');
  check('unknown intent is undefined', (await store.intents.getIntent('missing')) === undefined);

  // Pending: held intent listed, expired one filtered, resolved one filtered.
  const expired = makeIntent(`${label}-intent-expired`);
  await store.intents.putIntent(expired);
  await store.intents.putDecision(expired.id, makeDecision(expired, 'REQUIRE_APPROVAL', -1000));
  const resolved = makeIntent(`${label}-intent-resolved`);
  await store.intents.putIntent(resolved);
  await store.intents.putDecision(resolved.id, makeDecision(resolved, 'ALLOW'));
  const pending = await store.intents.pending();
  const ids = pending.map((p) => p.intent.id);
  check('pending lists the held intent', ids.includes(intent.id), ids);
  check('pending excludes expired and resolved intents', !ids.includes(expired.id) && !ids.includes(resolved.id), ids);

  // Ledger: rolling window accounting.
  const now = Date.now();
  await store.ledger.recordIssue('ledger-agent', 100n, now - 1000);
  await store.ledger.recordIssue('ledger-agent', 50n, now - 2000);
  await store.ledger.recordIssue('ledger-agent', 999n, now - 25 * 3600 * 1000); // outside the 24h window
  const day = 24 * 3600 * 1000;
  check('ledger sums in-window spend', (await store.ledger.issuedInWindow('ledger-agent', day, now)) === 150n);
  check('ledger ignores other agents', (await store.ledger.issuedInWindow('other-agent', day, now)) === 0n);

  // Audit: appends chain, verify passes, tampering is detected.
  const e1 = await store.audit.append('DECISION', intent.id, intent.agentId, { kind: 'REQUIRE_APPROVAL' });
  const e2 = await store.audit.append('APPROVAL', intent.id, intent.agentId, { approver: 'tester' });
  check('audit seq chains', e1.seq + 1 === e2.seq && e2.prevHash === e1.hash, { e1, e2 });
  check('audit verify clean', (await store.audit.verify()) === -1);
  const tail = await store.audit.tail(10);
  check('audit tail newest-first', tail.length >= 2 && tail[0].seq === e2.seq, tail.map((e) => e.seq));
  const tampered: AuditEntry[] = [
    { ...e1 },
    { ...e2, detail: { approver: 'mallory' } }, // hash no longer matches detail
  ];
  check('tampered chain detected at seq', verifyChain(tampered) === e2.seq, e2.seq);

  await store.close();
}

async function main() {
  await runSuite('memory', new MemoryStore());

  const pgUrl = process.env.TEST_DATABASE_URL ?? process.env.RVN_DATABASE_URL;
  if (pgUrl) {
    // Go through storeFromEnv (the same path the server uses) so default
    // seeding and backend selection are exercised too.
    const saved = process.env.RVN_DATABASE_URL;
    process.env.RVN_DATABASE_URL = pgUrl;
    const lines: string[] = [];
    try {
      const pgStore = await storeFromEnv((m) => lines.push(m));
      check('postgres backend selected', pgStore.kind === 'postgres', lines);
      // Wipe the non-policy tables so the suite is isolated from earlier
      // runs (policies keep the seeded default the suite asserts on).
      const admin = new Pool({ connectionString: pgUrl });
      await admin.query('TRUNCATE intents, decisions, audit_entries, ledger_spend');
      await admin.end();
      await runSuite('postgres', pgStore);
    } catch (err) {
      check('postgres suite ran', false, (err as Error).message);
    }
    process.env.RVN_DATABASE_URL = saved;
  } else {
    console.log('--- postgres: skipped (set TEST_DATABASE_URL to run against a live DB) ---');
  }

  // Fallback: unreachable database must not take the API down.
  const saved = process.env.RVN_DATABASE_URL;
  process.env.RVN_DATABASE_URL = 'postgres://127.0.0.1:1/unreachable_db';
  const lines: string[] = [];
  const fallback = await storeFromEnv((m) => lines.push(m));
  process.env.RVN_DATABASE_URL = saved;
  check('unreachable DB falls back to memory', fallback.kind === 'memory', lines);
  check('fallback still seeds the default policy', (await fallback.policies.get('*'))?.version === 1);
  check('fallback logs the reason', lines.some((l) => l.includes('falling back')), lines);
  await fallback.close();

  console.log(failures === 0 ? '\nAll store checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
