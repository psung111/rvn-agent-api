/**
 * archive-test: checks for audit retention (v0.24.0, slice 1 of the audit
 * retention & partitioning item) — archive export with a chain-verification
 * proof, retention pruning, and the POST /v1/audit/archive endpoint.
 *
 *  pnpm test:archive
 *
 * Covers:
 *   - buildArchive / verifyArchive / verifyContinuity (pure): valid
 *     archives, tampered entries, non-contiguous seqs, header mismatches,
 *     continuity across the archive boundary
 *   - retentionConfigFromEnv: defaults, valid overrides, invalid values
 *     degrading to defaults
 *   - the store seam (MemoryStore): oldest / beforeMs / prune, and the
 *     anchored verify() of a pruned chain
 *   - the endpoint against a booted API: 400 on a bad cutoff, nothing to
 *     archive, a real archive (file written, entries pruned, chain still
 *     valid, continuity holds against the live tail), and the AUDIT_ARCHIVED
 *     proof entry
 *
 * Nothing touches the network: the API is localhost-only, and archives are
 * written to a temp dir that is removed at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeChainedEntry, verifyChain, type AuditEntry } from '../src/audit.js';
import {
  buildArchive,
  MAX_ARCHIVE_ENTRIES,
  retentionConfigFromEnv,
  verifyArchive,
  verifyContinuity,
  type AuditArchive,
} from '../src/audit/archive.js';
import { MemoryStore } from '../src/store/index.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');
const API_PORT = 3130;
const API = `http://127.0.0.1:${API_PORT}`;
const AGENT = 'archive-agent';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

function makeEntries(n: number, startAtMs = 1_000_000): AuditEntry[] {
  const out: AuditEntry[] = [];
  let prev: AuditEntry | undefined;
  for (let i = 0; i < n; i++) {
    prev = makeChainedEntry(prev, 'DECISION', `intent-${i}`, AGENT, { i }, startAtMs + i * 1000);
    out.push(prev);
  }
  return out;
}

async function bootApi(archiveDir: string): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MOCK_RVN: 'true',
      RVN_AUDIT_RETENTION_DAYS: '7',
      RVN_AUDIT_ARCHIVE_DIR: archiveDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${API}/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not come up in time');
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function get(path: string) {
  const res = await fetch(`${API}${path}`);
  return res.json() as Promise<any>;
}

async function main() {
  // --- 1. pure archive functions ---
  const entries = makeEntries(5);
  const archive = buildArchive(entries);
  check('buildArchive covers the seq range',
    archive.firstSeq === 0 && archive.lastSeq === 4 && archive.entries.length === 5, archive);
  check('buildArchive prevHash is GENESIS at the chain head', archive.prevHash === 'GENESIS');
  check('buildArchive headHash is the last entry hash', archive.headHash === entries[4].hash);
  check('verifyArchive accepts a valid archive', verifyArchive(archive) === -1);

  const tampered: AuditEntry[] = entries.map((e) => ({ ...e }));
  tampered[2] = { ...tampered[2], detail: { i: 999 } }; // hash no longer matches detail
  const tamperedArchive: AuditArchive = { ...archive, entries: tampered };
  check('verifyArchive detects a tampered entry at its seq',
    verifyArchive(tamperedArchive) === 2, verifyArchive(tamperedArchive));
  check('buildArchive refuses a tampered slice', (() => {
    try {
      buildArchive(tampered);
      return false;
    } catch (err) {
      return String(err).includes('seq 2');
    }
  })());
  check('buildArchive refuses a non-contiguous slice', (() => {
    try {
      buildArchive([entries[0], entries[2]]);
      return false;
    } catch (err) {
      return String(err).includes('contiguous');
    }
  })());
  check('buildArchive refuses an empty list', (() => {
    try {
      buildArchive([]);
      return false;
    } catch {
      return true;
    }
  })());
  check('verifyArchive detects a wrong headHash',
    verifyArchive({ ...archive, headHash: 'deadbeef' }) === 0);
  check('verifyArchive detects a wrong firstSeq',
    verifyArchive({ ...archive, firstSeq: 1 }) === 0);
  check('verifyArchive detects a wrong prevHash',
    verifyArchive({ ...archive, prevHash: 'deadbeef' }) === 0);
  check('verifyArchive rejects a non-v1 document',
    verifyArchive({ ...archive, version: 2 as 1 }) === 0);
  check('verifyArchive on an empty document returns 0',
    verifyArchive({ ...archive, entries: [] }) === 0);

  // Continuity: the retained chain must start where the archive ended.
  const retained = makeEntries(2, 2_000_000);
  // Re-chain the retained slice onto the archive head by hand: the first
  // retained entry links to the archive head hash at lastSeq + 1.
  const continued: AuditEntry[] = [
    { ...retained[0], seq: archive.lastSeq + 1, prevHash: archive.headHash },
    { ...retained[1], seq: archive.lastSeq + 2, prevHash: retained[0].hash },
  ];
  check('verifyContinuity accepts the exact continuation', verifyContinuity(archive, continued));
  check('verifyContinuity rejects a wrong head hash',
    !verifyContinuity(archive, [{ ...continued[0], prevHash: 'deadbeef' }, continued[1]]));
  check('verifyContinuity rejects a seq gap',
    !verifyContinuity(archive, [{ ...continued[0], seq: archive.lastSeq + 2 }, continued[1]]));
  check('verifyContinuity accepts an empty retained chain', verifyContinuity(archive, []));
  check('verifyChain with a wrong anchor reports the first seq',
    verifyChain(entries, 'wrong-anchor') === 0);
  check('verifyChain anchored at the genesis prevHash passes',
    verifyChain(entries, entries[0].prevHash) === -1);

  // --- 2. retention config parsing ---
  check('retention defaults are 90 days in audit-archives',
    (() => {
      const c = retentionConfigFromEnv({});
      return c.retentionDays === 90 && c.archiveDir === 'audit-archives';
    })());
  check('retention env overrides are honored',
    (() => {
      const c = retentionConfigFromEnv({ RVN_AUDIT_RETENTION_DAYS: '30', RVN_AUDIT_ARCHIVE_DIR: ' /tmp/a ' });
      return c.retentionDays === 30 && c.archiveDir === '/tmp/a';
    })());
  for (const bad of ['0', '3651', 'soon', '1.5', '']) {
    check(`retention days ${JSON.stringify(bad)} falls back to 90`,
      retentionConfigFromEnv({ RVN_AUDIT_RETENTION_DAYS: bad }).retentionDays === 90);
  }
  check('retention days 1 and 3650 are accepted',
    retentionConfigFromEnv({ RVN_AUDIT_RETENTION_DAYS: '1' }).retentionDays === 1 &&
    retentionConfigFromEnv({ RVN_AUDIT_RETENTION_DAYS: '3650' }).retentionDays === 3650);
  check('empty archive dir falls back to the default',
    retentionConfigFromEnv({ RVN_AUDIT_ARCHIVE_DIR: '   ' }).archiveDir === 'audit-archives');
  check('MAX_ARCHIVE_ENTRIES is 10000', MAX_ARCHIVE_ENTRIES === 10_000);

  // --- 3. store seam (memory backend; the Postgres leg runs in test:store) ---
  const store = new MemoryStore();
  for (let i = 0; i < 5; i++) {
    await store.audit.append('DECISION', `store-intent-${i}`, AGENT, { i });
  }
  const allBefore = await store.audit.beforeMs(Date.now() + 1000);
  check('beforeMs returns entries ascending by seq',
    allBefore.length === 5 && allBefore[0].seq === 0 && allBefore[4].seq === 4,
    allBefore.map((e) => e.seq));
  check('beforeMs with an ancient cutoff returns nothing',
    (await store.audit.beforeMs(0)).length === 0);
  check('beforeMs limit is honored', (await store.audit.beforeMs(Date.now() + 1000, 2)).length === 2);
  check('oldest returns the genesis entry', (await store.audit.oldest())?.seq === 0);
  check('prune(3) deletes seqs 0..2', (await store.audit.prune(3)) === 3);
  check('oldest after prune is seq 3', (await store.audit.oldest())?.seq === 3);
  check('pruned chain still verifies (anchored)',
    (await store.audit.verify()) === -1);
  check('prune past the newest keeps the anchor entry',
    (await store.audit.prune(999)) === 1 && (await store.audit.oldest())?.seq === 4);
  check('chain verifies after pruning to a single entry', (await store.audit.verify()) === -1);
  const afterAppend = await store.audit.append('DECISION', 'store-intent-5', AGENT, { i: 5 });
  check('append after a prune chains onto the anchor',
    afterAppend.seq === 5 && afterAppend.prevHash === (await store.audit.tail(2))[1].hash);
  check('chain verifies after append-on-pruned-chain', (await store.audit.verify()) === -1);
  await store.close();

  // --- 4. endpoint integration against a booted API ---
  const archiveDir = mkdtempSync(join(tmpdir(), 'rvn-audit-archive-'));
  const api = await bootApi(archiveDir);
  try {
    const health = await get('/v1/health');
    check('health reports the retention config from env',
      health.audit?.retentionDays === 7 && health.audit?.archiveDir === archiveDir, health.audit);

    const wallet = (await post('/v1/wallets', {})).json.address as string;
    const policy = await get(`/v1/policies/${AGENT}`);
    const putRes = await fetch(`${API}/v1/policies/${AGENT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...policy, agentId: AGENT, allowedDestinations: [wallet] }),
    });
    check('policy PUT allowlists the wallet', putRes.status === 200);
    for (const name of ['ARCHCOIN1', 'ARCHCOIN2']) {
      const r = await post('/v1/assets/issue', { agentId: AGENT, name, qty: '100', toAddress: wallet });
      check(`issue ${name} ALLOWs`, r.json.decision?.kind === 'ALLOW', r.json);
    }
    // Entries so far: 1 policy PUT + 2 issues x (DECISION + EXECUTION_SKIPPED) = 5, seqs 0..4.
    const auditBefore = await get('/v1/audit?limit=200');
    check('five audit entries before archiving', auditBefore.entries.length === 5, auditBefore.entries.length);

    const bad = await post('/v1/audit/archive', { beforeMs: 'soon' });
    check('archive with a non-numeric beforeMs is a 400',
      bad.status === 400 && typeof bad.json.error === 'string', bad.json);
    const none = await post('/v1/audit/archive', { beforeMs: 1 });
    check('archive with an ancient cutoff archives nothing',
      none.status === 200 && none.json.archived === false && none.json.entries === 0, none.json);
    check('nothing was pruned by the no-op archive',
      (await get('/v1/audit?limit=200')).entries.length === 5);

    const res = await post('/v1/audit/archive', { beforeMs: Date.now() + 60_000 });
    check('archive archives everything but the newest entry',
      res.status === 200 && res.json.archived === true && res.json.entries === 4 &&
      res.json.firstSeq === 0 && res.json.lastSeq === 3 &&
      res.json.pruned === 4 && res.json.continuityOk === true &&
      res.json.moreMayRemain === false, res.json);

    const files = readdirSync(archiveDir);
    check('one archive file was written',
      files.length === 1 && files[0] === 'audit-archive-0-3.json', files);
    const fileArchive = JSON.parse(readFileSync(join(archiveDir, files[0]), 'utf8')) as AuditArchive;
    check('archive file verifies', verifyArchive(fileArchive) === -1);
    check('archive file headHash matches the endpoint response',
      fileArchive.headHash === res.json.headHash);

    const auditAfter = await get('/v1/audit?limit=200');
    check('live chain still verifies after the prune', auditAfter.chainValid === true);
    check('live chain holds the anchor plus the AUDIT_ARCHIVED proof',
      auditAfter.entries.length === 2 &&
      auditAfter.entries[0].kind === 'AUDIT_ARCHIVED' &&
      auditAfter.entries[1].seq === 4, auditAfter.entries.map((e: any) => ({ seq: e.seq, kind: e.kind })));
    const proof = auditAfter.entries[0].detail as Record<string, unknown>;
    check('AUDIT_ARCHIVED entry records the proof',
      proof.firstSeq === 0 && proof.lastSeq === 3 && proof.headHash === res.json.headHash &&
      proof.archiveFile === 'audit-archive-0-3.json', proof);
    const retainedOldest = auditAfter.entries[auditAfter.entries.length - 1];
    check('retained oldest entry prevHash equals the archive headHash',
      retainedOldest.prevHash === fileArchive.headHash, retainedOldest.prevHash);
    const retainedAscending = [...auditAfter.entries].reverse(); // oldest first
    check('retained chain continues the archive (continuity proof)',
      verifyContinuity(fileArchive, retainedAscending));

    const again = await post('/v1/audit/archive', { beforeMs: 1 });
    check('a second archive with an ancient cutoff archives nothing',
      again.json.archived === false && again.json.entries === 0, again.json);
  } finally {
    api.kill();
    rmSync(archiveDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll archive checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
