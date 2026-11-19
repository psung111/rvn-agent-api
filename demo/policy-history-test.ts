/**
 * policy-history-test: checks for the policy history + rollback item (v0.35.0).
 *
 *  pnpm test:policy-history
 *
 * Unit: history-limit env parsing, version snapshot fields, and the
 * newest-N prune. Integration: boots the real API as a child process
 * (MOCK_RVN=true) and drives PUT / preset / rollback through the routes —
 * history accumulates superseded versions newest first, a rollback
 * restores the named version and is itself undoable, unknown/missing
 * version ids fail cleanly, the limit env prunes the oldest versions,
 * and on a second auth-on API a per-agent key reads only its own
 * history. Nothing touches the network beyond localhost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  DEFAULT_POLICY_HISTORY_LIMIT,
  defaultPolicy,
  MAX_POLICY_HISTORY_LIMIT,
  MIN_POLICY_HISTORY_LIMIT,
  newPolicyVersion,
  policyHistoryLimitFromEnv,
  pruneVersions,
  type PolicyVersion,
  type RvnPolicy,
} from '../src/policy/index.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3143;
const API2_PORT = 3144;
const API3_PORT = 3145;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2 = `http://127.0.0.1:${API2_PORT}`;
const API3 = `http://127.0.0.1:${API3_PORT}`;
const OPERATOR_KEY = 'rvn_operator-testkey-0123456789abcdef';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function bootApi(port: number, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(port), MOCK_RVN: 'true', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API on port ${port} did not come up`);
}

async function kill(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
}

function policyFor(agentId: string, maxIssue: string): RvnPolicy {
  return { ...defaultPolicy(agentId), maxIssueQtyBaseUnits: maxIssue };
}

async function putPolicy(base: string, agentId: string, maxIssue: string): Promise<Response> {
  return fetch(`${base}/v1/policies/${encodeURIComponent(agentId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(policyFor(agentId, maxIssue)),
  });
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.json() as any };
}

async function unitChecks(): Promise<void> {
  check('defaults: limit 10', policyHistoryLimitFromEnv({}) === 10);
  check('DEFAULT/MIN/MAX constants', DEFAULT_POLICY_HISTORY_LIMIT === 10 &&
    MIN_POLICY_HISTORY_LIMIT === 1 && MAX_POLICY_HISTORY_LIMIT === 100);
  check('valid value parses', policyHistoryLimitFromEnv({ RVN_POLICY_HISTORY_LIMIT: '3' }) === 3);
  check('non-numeric falls back', policyHistoryLimitFromEnv({ RVN_POLICY_HISTORY_LIMIT: 'abc' }) === 10);
  check('below min falls back', policyHistoryLimitFromEnv({ RVN_POLICY_HISTORY_LIMIT: '0' }) === 10);
  check('above max falls back', policyHistoryLimitFromEnv({ RVN_POLICY_HISTORY_LIMIT: '101' }) === 10);
  check('fractional falls back', policyHistoryLimitFromEnv({ RVN_POLICY_HISTORY_LIMIT: '2.5' }) === 10);
  check('max value parses', policyHistoryLimitFromEnv({ RVN_POLICY_HISTORY_LIMIT: '100' }) === 100);

  const p = policyFor('hist-agent', '1000');
  const v = newPolicyVersion(p, 'preset', 1234, { preset: 'balanced' });
  check('version snapshots the policy', v.policy === p && v.agentId === 'hist-agent');
  check('version carries source + preset', v.replacedBy === 'preset' && v.preset === 'balanced' && v.replacedAtMs === 1234);
  check('version has an id', typeof v.versionId === 'string' && v.versionId.length > 0);
  check('two versions get distinct ids', newPolicyVersion(p, 'put', 1).versionId !== newPolicyVersion(p, 'put', 1).versionId);
  const rollbackVersion = newPolicyVersion(p, 'rollback', 5, { sourceVersionId: 'v-1' });
  check('rollback version carries sourceVersionId', rollbackVersion.sourceVersionId === 'v-1' && rollbackVersion.preset === undefined);

  const mk = (id: string, at: number): PolicyVersion => ({
    versionId: id, agentId: 'a', policy: p, replacedAtMs: at, replacedBy: 'put',
  });
  const three = [mk('newest', 30), mk('mid', 20), mk('oldest', 10)];
  check('prune keeps newest N', pruneVersions(three, 2).map((x) => x.versionId).join(',') === 'newest,mid');
  check('prune keeps all when under limit', pruneVersions(three, 10).length === 3);
  check('prune limit 0 keeps one', pruneVersions(three, 0).length === 1);
}

async function integrationChecks(): Promise<void> {
  const api = await bootApi(API1_PORT);
  try {
    const agent = 'hist-agent';
    const health = await getJson(`${API1}/v1/health`);
    check('health reports policyHistory limit 10', health.body.policyHistory?.limit === 10, health.body.policyHistory);

    const empty = await getJson(`${API1}/v1/policies/${agent}/history`);
    check('fresh agent history is empty', empty.status === 200 && empty.body.versions.length === 0 && empty.body.limit === 10, empty.body);

    // First PUT: no own stored policy yet, so nothing is archived.
    const put1 = await putPolicy(API1, agent, '1000');
    check('first PUT succeeds', put1.status === 200, await put1.text());
    const afterFirst = await getJson(`${API1}/v1/policies/${agent}/history`);
    check('first PUT archives nothing (no previous own policy)', afterFirst.body.versions.length === 0, afterFirst.body);

    // Second PUT: the first policy is archived as version 1.
    const put2 = await putPolicy(API1, agent, '2000');
    check('second PUT succeeds', put2.status === 200);
    const afterSecond = await getJson(`${API1}/v1/policies/${agent}/history`);
    check('second PUT archives the first policy', afterSecond.body.versions.length === 1, afterSecond.body);
    const v1 = afterSecond.body.versions[0] as PolicyVersion;
    check('archived version is the first policy, source put',
      v1.policy.maxIssueQtyBaseUnits === '1000' && v1.replacedBy === 'put' && v1.agentId === agent, v1);

    // Preset apply: archives the second policy with the preset name.
    const preset = await fetch(`${API1}/v1/policies/${agent}/preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset: 'balanced' }),
    });
    check('preset apply succeeds', preset.status === 200, await preset.text());
    const afterPreset = await getJson(`${API1}/v1/policies/${agent}/history`);
    check('preset archives the previous policy newest-first', afterPreset.body.versions.length === 2, afterPreset.body);
    const newest = afterPreset.body.versions[0] as PolicyVersion;
    check('newest version is the PUT policy, source preset',
      newest.policy.maxIssueQtyBaseUnits === '2000' && newest.replacedBy === 'preset' && newest.preset === 'balanced', newest);
    check('older version still there', afterPreset.body.versions[1].versionId === v1.versionId);

    // ?limit= caps the rows returned.
    const limited = await getJson(`${API1}/v1/policies/${agent}/history?limit=1`);
    check('?limit=1 returns one version', limited.body.versions.length === 1 && limited.body.limit === 1, limited.body);

    // Rollback to the first version restores maxIssue 1000.
    const rollback = await fetch(`${API1}/v1/policies/${agent}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: v1.versionId }),
    });
    const rollbackBody = await rollback.json() as any;
    check('rollback succeeds and restores the version',
      rollback.status === 200 && rollbackBody.policy.maxIssueQtyBaseUnits === '1000' &&
      rollbackBody.restoredFrom === v1.versionId, rollbackBody);
    const live = await getJson(`${API1}/v1/policies/${agent}`);
    check('live policy is the restored one', live.body.maxIssueQtyBaseUnits === '1000', live.body);

    // The rollback itself archived the preset policy — undoable.
    const afterRollback = await getJson(`${API1}/v1/policies/${agent}/history`);
    check('rollback archives the replaced policy', afterRollback.body.versions.length === 3, afterRollback.body);
    const rb = afterRollback.body.versions[0] as PolicyVersion;
    check('rollback version names its source',
      rb.replacedBy === 'rollback' && rb.sourceVersionId === v1.versionId &&
      rb.policy.maxIssueQtyBaseUnits === '100000', rb);
    const undo = await fetch(`${API1}/v1/policies/${agent}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: rb.versionId }),
    });
    const undoBody = await undo.json() as any;
    check('rolling back the rollback restores the preset policy',
      undo.status === 200 && undoBody.policy.maxIssueQtyBaseUnits === '100000', undoBody);

    // Errors: unknown version 404s, missing versionId 400s, nothing changes.
    const unknown = await fetch(`${API1}/v1/policies/${agent}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: 'no-such-version' }),
    });
    check('unknown versionId 404s', unknown.status === 404, await unknown.text());
    const missing = await fetch(`${API1}/v1/policies/${agent}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('missing versionId 400s', missing.status === 400, await missing.text());
    const stillLive = await getJson(`${API1}/v1/policies/${agent}`);
    check('failed rollbacks change nothing', stillLive.body.maxIssueQtyBaseUnits === '100000', stillLive.body);

    // The rollback is audited as POLICY_REPLACED naming the source version.
    const audit = await getJson(`${API1}/v1/audit?limit=500`);
    const rbAudit = (audit.body.entries as any[]).find(
      (e) => e.kind === 'DECISION' && e.detail?.kind === 'POLICY_REPLACED' && e.detail?.rollbackFrom === v1.versionId,
    );
    check('rollback audited as POLICY_REPLACED with rollbackFrom', rbAudit !== undefined, audit.body.entries?.length);

    // Chain still valid after all the policy churn.
    const verify = await getJson(`${API1}/v1/audit?limit=1`);
    check('audit chain intact', verify.body.chainValid === true, verify.body);
  } finally {
    await kill(api);
  }
}

async function capChecks(): Promise<void> {
  const api = await bootApi(API3_PORT, { RVN_POLICY_HISTORY_LIMIT: '2' });
  try {
    const agent = 'cap-agent';
    const health = await getJson(`${API3}/v1/health`);
    check('limit env reaches health', health.body.policyHistory?.limit === 2, health.body.policyHistory);
    for (const qty of ['1000', '2000', '3000', '4000']) {
      const r = await putPolicy(API3, agent, qty);
      if (r.status !== 200) throw new Error(`PUT ${qty} failed: ${await r.text()}`);
    }
    const hist = await getJson(`${API3}/v1/policies/${agent}/history`);
    check('history capped at 2', hist.body.versions.length === 2, hist.body);
    check('cap keeps the two newest, oldest dropped',
      hist.body.versions[0].policy.maxIssueQtyBaseUnits === '3000' &&
      hist.body.versions[1].policy.maxIssueQtyBaseUnits === '2000', hist.body);
    // The dropped version can no longer be rolled back to.
    const dropped = hist.body.versions.find((v: PolicyVersion) => v.policy.maxIssueQtyBaseUnits === '1000');
    check('oldest version is gone from history', dropped === undefined);
  } finally {
    await kill(api);
  }
}

async function authChecks(): Promise<void> {
  const api = await bootApi(API2_PORT, { RVN_AUTH_ENABLED: 'true', RVN_OPERATOR_API_KEY: OPERATOR_KEY });
  try {
    const op = { Authorization: `Bearer ${OPERATOR_KEY}` };
    // Seed a history for hist-agent via the operator key.
    const seed = async (qty: string): Promise<void> => {
      const r = await fetch(`${API2}/v1/policies/hist-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...op },
        body: JSON.stringify(policyFor('hist-agent', qty)),
      });
      if (r.status !== 200) throw new Error(`seed PUT ${qty} failed: ${await r.text()}`);
    };
    await seed('1000');
    await seed('2000');
    const issued = await fetch(`${API2}/v1/admin/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...op },
      body: JSON.stringify({ agentId: 'hist-agent' }),
    });
    const issuedBody = await issued.json() as any;
    check('operator issues a per-agent key', issued.status === 200 && typeof issuedBody.key === 'string', issuedBody);
    const keyHeaders = { Authorization: `Bearer ${issuedBody.key}` };
    const own = await getJson(`${API2}/v1/policies/hist-agent/history`, keyHeaders);
    check('per-agent key reads its own history', own.status === 200 && own.body.versions.length === 1, own.body);
    const other = await getJson(`${API2}/v1/policies/other-agent/history`, keyHeaders);
    check('per-agent key 403s on another agent history', other.status === 403, other.body);
    const rollbackOther = await fetch(`${API2}/v1/policies/other-agent/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...keyHeaders },
      body: JSON.stringify({ versionId: 'x' }),
    });
    check('per-agent key 403s on another agent rollback', rollbackOther.status === 403, await rollbackOther.text());
  } finally {
    await kill(api);
  }
}

await unitChecks();
await integrationChecks();
await capChecks();
await authChecks();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\npolicy-history: all checks passed');
