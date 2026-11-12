/**
 * quorum-test: checks for multi-approver quorum (v0.27.0, slice 1; roster
 * in v0.28.0, slice 2).
 *
 *  pnpm test:quorum
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - config parse/validate split: lenient quorumConfigFromPolicy
 *     (missing/malformed sides degrade to no quorum, never a crash) and
 *     strict validateQuorumFields (count < 2, half-configured quorum,
 *     malformed thresholds all rejected) — plus the roster split:
 *     normalizeRoster (trim/dedup/drop-empties) and strict roster
 *     validation (roster-only, count > roster size, empty/non-string
 *     entries all rejected)
 *   - PUT validation: bad quorum fields 400 and leave the stored policy
 *     untouched; preset overrides validate the same way
 *   - below the quorum threshold a single approver still executes
 *     (quorumRequired absent from the decision)
 *   - above the quorum threshold the hold carries quorumRequired N; the
 *     reason is QUORUM_REQUIRED when the quorum threshold is the only
 *     reason for the hold, and the earlier hold reason (e.g.
 *     ABOVE_APPROVAL_THRESHOLD) when the intent was already held — the
 *     quorum count rides the hold either way. One approval returns 202
 *     with 1/N and executes nothing; the same approver again still
 *     counts 1 (alreadyCounted); a second distinct approver executes
 *     (200 + txid, 2/2); the hold leaves the pending list
 *   - a deny by one approver ends a quorum hold outright (approve after
 *     returns 409)
 *   - a transfer above the transfer quorum threshold holds the same way
 *     even though it would otherwise ALLOW
 *   - simulate reports the quorum decision with zero side effects
 *     (no audit entries, no pending intent)
 *   - roster (slice 2): a hold above the threshold snapshots the roster
 *     (M) onto the decision and reports n/N of M in pending; an
 *     approver outside the roster gets 403 and the count does not move;
 *     roster members count once each and the Nth executes with the full
 *     count; a deny by a non-roster approver still ends the hold; a
 *     policy change after the hold cannot change who may approve it
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  normalizeRoster,
  quorumConfigFromPolicy,
  validateQuorumFields,
} from '../src/policy/quorum.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3129;
const API = `http://127.0.0.1:${API_PORT}`;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function bootApi(): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(API_PORT), MOCK_RVN: 'true' },
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

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const get = (path: string) => req('GET', path);
const post = (path: string, body: unknown) => req('POST', path, body);
const put = (path: string, body: unknown) => req('PUT', path, body);

function basePolicy(agentId: string, quorum: Record<string, unknown> = {}) {
  return {
    version: 1,
    agentId,
    maxIssueQtyBaseUnits: '100000',
    approvalAboveIssueQtyBaseUnits: '10000',
    dailyIssueBudgetBaseUnits: '500000',
    maxTransferQtyBaseUnits: '50000',
    approvalAboveTransferQtyBaseUnits: '5000',
    allowedDestinations: [] as string[],
    blockedDestinations: [],
    assetNamePattern: '^[A-Z0-9._]{3,30}$',
    decisionTtlSeconds: 3600,
    ...quorum,
  };
}

async function main(): Promise<void> {
  // ---- 0. config parse/validate unit checks (no API needed) ----
  check('empty policy resolves to no quorum', quorumConfigFromPolicy({}) === undefined);
  check(
    'valid issue threshold resolves (approvals 2, threshold 50000)',
    (() => {
      const c = quorumConfigFromPolicy({ quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000' });
      return c?.approvals === 2 && c?.issueThreshold === 50000n && c?.transferThreshold === undefined;
    })(),
  );
  check(
    'both thresholds resolve',
    (() => {
      const c = quorumConfigFromPolicy({
        quorumApprovals: 3,
        quorumAboveIssueQtyBaseUnits: '50000',
        quorumAboveTransferQtyBaseUnits: '1000',
      });
      return c?.approvals === 3 && c?.issueThreshold === 50000n && c?.transferThreshold === 1000n;
    })(),
  );
  check('approvals of 1 degrades to no quorum (a quorum of one is the default flow)',
    quorumConfigFromPolicy({ quorumApprovals: 1, quorumAboveIssueQtyBaseUnits: '50000' }) === undefined);
  check('threshold without a count degrades to no quorum',
    quorumConfigFromPolicy({ quorumAboveIssueQtyBaseUnits: '50000' }) === undefined);
  check('count without a threshold degrades to no quorum',
    quorumConfigFromPolicy({ quorumApprovals: 2 }) === undefined);
  check('malformed threshold degrades that side (both malformed = no quorum)',
    quorumConfigFromPolicy({ quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: 'ten' }) === undefined);
  check('negative threshold degrades to no quorum',
    quorumConfigFromPolicy({ quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '-5' }) === undefined);
  check('strict validation accepts a full valid set',
    validateQuorumFields({ quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000' }) === undefined);
  check('strict validation accepts an empty set', validateQuorumFields({}) === undefined);
  for (const bad of [
    { quorumApprovals: 1, quorumAboveIssueQtyBaseUnits: '50000' },
    { quorumApprovals: 0, quorumAboveIssueQtyBaseUnits: '50000' },
    { quorumApprovals: 1.5, quorumAboveIssueQtyBaseUnits: '50000' },
    { quorumApprovals: '2' as unknown as number, quorumAboveIssueQtyBaseUnits: '50000' },
    { quorumApprovals: 2 },
    { quorumAboveIssueQtyBaseUnits: '50000' },
    { quorumAboveTransferQtyBaseUnits: '1000' },
    { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: 'ten' },
    { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '-5' },
    { quorumApprovals: 2, quorumAboveTransferQtyBaseUnits: '1.5' },
  ]) {
    check(`strict validation rejects ${JSON.stringify(bad)}`,
      typeof validateQuorumFields(bad) === 'string', validateQuorumFields(bad));
  }

  // ---- 0b. roster parse/validate unit checks (v0.28.0) ----
  check('normalizeRoster trims, dedups, and drops empties/non-strings',
    JSON.stringify(normalizeRoster([' alice ', 'bob', 'alice', '', '  ', 7, 'carol'])) === JSON.stringify(['alice', 'bob', 'carol']),
    normalizeRoster([' alice ', 'bob', 'alice', '', '  ', 7, 'carol']));
  check('normalizeRoster of a non-array is undefined', normalizeRoster('alice') === undefined);
  check('normalizeRoster of an all-empty array is undefined', normalizeRoster(['', '  ']) === undefined);
  check('roster resolves on a valid quorum config',
    JSON.stringify(quorumConfigFromPolicy({
      quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', 'bob', 'carol'],
    })?.approvers) === JSON.stringify(['alice', 'bob', 'carol']));
  check('roster normalizes on resolve (dupes and whitespace dropped)',
    JSON.stringify(quorumConfigFromPolicy({
      quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: [' bob ', 'alice', 'bob'],
    })?.approvers) === JSON.stringify(['bob', 'alice']));
  check('no roster key means no roster on the config',
    quorumConfigFromPolicy({ quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000' })?.approvers === undefined);
  check('strict validation accepts a full valid set with a roster',
    validateQuorumFields({
      quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', 'bob', 'carol'],
    }) === undefined);
  check('strict validation accepts a roster exactly the quorum size',
    validateQuorumFields({
      quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', 'bob'],
    }) === undefined);
  for (const bad of [
    { quorumApprovers: ['alice', 'bob'] },
    { quorumApprovals: 2, quorumApprovers: ['alice', 'bob'] },
    { quorumApprovals: 3, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', 'bob'] },
    { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: 'alice' as unknown as string[] },
    { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: [] },
    { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', ''] },
    { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', 7 as unknown as string] },
  ]) {
    check(`strict validation rejects roster config ${JSON.stringify(bad)}`,
      typeof validateQuorumFields(bad) === 'string', validateQuorumFields(bad));
  }

  const api = await bootApi();
  try {
    const health = await get('/v1/health');
    check('API booted in mock mode', health.json?.ok === true && health.json?.mock === true);

    const wallet = (await post('/v1/wallets', {})).json?.address as string;
    check('wallet provisioned', typeof wallet === 'string' && wallet.length > 0, wallet);

    // ---- 1. PUT validation: bad quorum fields 400, policy untouched ----
    const agent = 'quorum-agent';
    const good = basePolicy(agent, {
      quorumApprovals: 2,
      quorumAboveIssueQtyBaseUnits: '50000',
      allowedDestinations: [wallet],
    });
    const putGood = await put(`/v1/policies/${agent}`, good);
    check('PUT with a valid quorum config stores the policy', putGood.status === 200, putGood.json);
    const badPolicies: Array<Record<string, unknown>> = [
      { ...good, quorumApprovals: 1 },
      { ...good, quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: undefined },
      { ...good, quorumApprovals: undefined, quorumAboveIssueQtyBaseUnits: '50000' },
      { ...good, quorumAboveIssueQtyBaseUnits: 'ten' },
      // Roster cases (v0.28.0): count above roster size, roster with no
      // count, roster with no threshold, empty roster, non-string entry.
      { ...good, quorumApprovals: 3, quorumApprovers: ['alice', 'bob'] },
      { ...good, quorumApprovals: undefined, quorumAboveIssueQtyBaseUnits: undefined, quorumApprovers: ['alice', 'bob'] },
      { ...good, quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: undefined, quorumApprovers: ['alice', 'bob'] },
      { ...good, quorumApprovers: [] },
      { ...good, quorumApprovers: ['alice', 7] },
    ];
    for (const bad of badPolicies) {
      const r = await put(`/v1/policies/${agent}`, bad);
      check(`PUT rejects bad quorum config ${JSON.stringify({ quorumApprovals: bad.quorumApprovals, quorumAboveIssueQtyBaseUnits: bad.quorumAboveIssueQtyBaseUnits, quorumApprovers: bad.quorumApprovers })}`,
        r.status === 400, r.json);
    }
    const stored = await get(`/v1/policies/${agent}`);
    check('rejected PUTs left the stored policy untouched',
      stored.json?.quorumApprovals === 2 && stored.json?.quorumAboveIssueQtyBaseUnits === '50000', stored.json);

    // ---- 2. preset overrides validate the same way ----
    const presetBad = await post(`/v1/policies/preset-agent/preset`, {
      preset: 'balanced',
      overrides: { quorumApprovals: 1 },
    });
    check('preset override with quorumApprovals 1 is rejected', presetBad.status === 400, presetBad.json);
    const presetBad2 = await post(`/v1/policies/preset-agent/preset`, {
      preset: 'balanced',
      overrides: { quorumAboveIssueQtyBaseUnits: '50000' },
    });
    check('preset override with a threshold but no count is rejected', presetBad2.status === 400, presetBad2.json);
    const presetGood = await post(`/v1/policies/preset-agent/preset`, {
      preset: 'balanced',
      overrides: { quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000', allowedDestinations: [wallet] },
    });
    check('preset override with a valid quorum config applies',
      presetGood.status === 200 && presetGood.json?.policy?.quorumApprovals === 2, presetGood.json);
    const presetRosterBad = await post(`/v1/policies/preset-agent/preset`, {
      preset: 'balanced',
      overrides: { quorumApprovals: 3, quorumAboveIssueQtyBaseUnits: '50000', quorumApprovers: ['alice', 'bob'] },
    });
    check('preset override with a count above the roster size is rejected',
      presetRosterBad.status === 400, presetRosterBad.json);
    const presetRosterGood = await post(`/v1/policies/preset-agent/preset`, {
      preset: 'balanced',
      overrides: {
        quorumApprovals: 2, quorumAboveIssueQtyBaseUnits: '50000',
        quorumApprovers: ['alice', 'bob', 'carol'], allowedDestinations: [wallet],
      },
    });
    check('preset override with a valid roster applies',
      presetRosterGood.status === 200 &&
      JSON.stringify(presetRosterGood.json?.policy?.quorumApprovers) === JSON.stringify(['alice', 'bob', 'carol']),
      presetRosterGood.json);

    // ---- 3. below the quorum threshold: single approver still executes ----
    const small = await post('/v1/assets/issue', {
      agentId: agent, name: 'SMALLCOIN', qty: '20000', toAddress: wallet,
    });
    check('issue above the approval threshold but below quorum holds (202)',
      small.status === 202 && small.json?.decision?.kind === 'REQUIRE_APPROVAL', small.json);
    check('below-quorum hold carries no quorumRequired',
      small.json?.decision?.quorumRequired === undefined, small.json?.decision);
    check('below-quorum hold reason is the approval threshold, not quorum',
      small.json?.decision?.reasonCodes?.includes('ABOVE_APPROVAL_THRESHOLD') === true, small.json?.decision);
    const smallApprove = await post(`/v1/intents/${small.json.intent.id}/approve`, { approver: 'alice' });
    check('single approver executes the below-quorum hold',
      smallApprove.status === 200 && !!smallApprove.json?.txid, smallApprove.json);

    // ---- 4. above the quorum threshold: N distinct approvers ----
    const big = await post('/v1/assets/issue', {
      agentId: agent, name: 'BIGCOIN', qty: '60000', toAddress: wallet,
    });
    check('issue above the quorum threshold holds (202)',
      big.status === 202 && big.json?.decision?.kind === 'REQUIRE_APPROVAL', big.json);
    check('quorum hold carries quorumRequired 2 (reason stays the approval threshold — the quorum count rides the hold)',
      big.json?.decision?.quorumRequired === 2 &&
      big.json?.decision?.reasonCodes?.includes('ABOVE_APPROVAL_THRESHOLD') === true, big.json?.decision);
    const pendingBefore = await get('/v1/intents/pending');
    check('quorum hold shows in pending with its quorum requirement',
      pendingBefore.json?.pending?.some((p: any) => p.intent.id === big.json.intent.id && p.decision.quorumRequired === 2) === true,
      pendingBefore.json?.pending?.length);
    const first = await post(`/v1/intents/${big.json.intent.id}/approve`, { approver: 'alice' });
    check('first approval returns 202 with 1/2 and no txid',
      first.status === 202 && first.json?.approvalsReceived === 1 && first.json?.approvalsRequired === 2 &&
      first.json?.txid === undefined, first.json);
    const pendingMid = await get('/v1/intents/pending');
    check('hold is still pending after the first approval',
      pendingMid.json?.pending?.some((p: any) => p.intent.id === big.json.intent.id) === true);
    const dup = await post(`/v1/intents/${big.json.intent.id}/approve`, { approver: 'alice' });
    check('the same approver twice still counts 1 (alreadyCounted)',
      dup.status === 202 && dup.json?.approvalsReceived === 1 && dup.json?.alreadyCounted === true, dup.json);
    const assetsMid = await get('/v1/assets?pattern=BIGCOIN');
    check('no supply was created by the partial approvals',
      (assetsMid.json?.assets ?? []).length === 0, assetsMid.json);
    const second = await post(`/v1/intents/${big.json.intent.id}/approve`, { approver: 'bob' });
    check('second distinct approver executes (200, txid, 2/2)',
      second.status === 200 && !!second.json?.txid &&
      second.json?.approvalsReceived === 2 && second.json?.approvalsRequired === 2, second.json);
    const pendingAfter = await get('/v1/intents/pending');
    check('executed quorum hold leaves the pending list',
      pendingAfter.json?.pending?.every((p: any) => p.intent.id !== big.json.intent.id) === true);
    const again = await post(`/v1/intents/${big.json.intent.id}/approve`, { approver: 'carol' });
    check('re-approving an executed quorum hold returns 409', again.status === 409, again.json);

    // ---- 5. one approver can still deny a quorum hold outright ----
    const doomed = await post('/v1/assets/issue', {
      agentId: agent, name: 'DOOMCOIN', qty: '60000', toAddress: wallet,
    });
    check('second quorum hold raised', doomed.status === 202 && doomed.json?.decision?.quorumRequired === 2, doomed.json);
    const denied = await post(`/v1/intents/${doomed.json.intent.id}/deny`, { approver: 'carol' });
    check('a single deny ends a quorum hold', denied.status === 200 && denied.json?.denied === true, denied.json);
    const deniedApprove = await post(`/v1/intents/${doomed.json.intent.id}/approve`, { approver: 'alice' });
    check('approving a denied quorum hold returns 409', deniedApprove.status === 409, deniedApprove.json);

    // ---- 6. transfer quorum threshold: a would-ALLOW transfer holds ----
    const tAgent = 'quorum-transfer';
    const tPut = await put(`/v1/policies/${tAgent}`, basePolicy(tAgent, {
      quorumApprovals: 2,
      quorumAboveTransferQtyBaseUnits: '1000',
      allowedDestinations: [wallet],
    }));
    check('transfer-quorum policy stores', tPut.status === 200, tPut.json);
    const transfer = await post('/v1/assets/transfer', {
      agentId: tAgent, assetName: 'BIGCOIN', qty: '2000', destination: wallet,
    });
    check('transfer above the quorum threshold but below the approval threshold holds',
      transfer.status === 202 && transfer.json?.decision?.kind === 'REQUIRE_APPROVAL', transfer.json);
    check('transfer quorum hold carries quorumRequired 2 and QUORUM_REQUIRED',
      transfer.json?.decision?.quorumRequired === 2 &&
      transfer.json?.decision?.reasonCodes?.includes('QUORUM_REQUIRED') === true, transfer.json?.decision);
    const tFirst = await post(`/v1/intents/${transfer.json.intent.id}/approve`, { approver: 'alice' });
    check('transfer first approval is 202 with 1/2',
      tFirst.status === 202 && tFirst.json?.approvalsReceived === 1, tFirst.json);
    const tSecond = await post(`/v1/intents/${transfer.json.intent.id}/approve`, { approver: 'bob' });
    check('transfer second approval executes', tSecond.status === 200 && !!tSecond.json?.txid, tSecond.json);

    // ---- 7. simulate reports the quorum decision with zero side effects ----
    const auditBefore = await get('/v1/audit?limit=1');
    const seqBefore = auditBefore.json?.entries?.[0]?.seq ?? 0;
    const pendingBeforeSim = await get('/v1/intents/pending');
    const sim = await post('/v1/intents/simulate', {
      op: 'issue', agentId: agent, assetName: 'SIMCOIN', qty: '60000', destination: wallet,
    });
    check('simulate reports the quorum hold (quorumRequired 2 on the approval-threshold hold)',
      sim.json?.simulated === true && sim.json?.decision?.kind === 'REQUIRE_APPROVAL' &&
      sim.json?.decision?.quorumRequired === 2 &&
      sim.json?.decision?.reasonCodes?.includes('ABOVE_APPROVAL_THRESHOLD') === true, sim.json);
    const auditAfter = await get('/v1/audit?limit=1');
    const pendingAfterSim = await get('/v1/intents/pending');
    check('simulate wrote no audit entries and created no pending intent',
      (auditAfter.json?.entries?.[0]?.seq ?? 0) === seqBefore &&
      pendingAfterSim.json?.pending?.length === pendingBeforeSim.json?.pending?.length,
      { seqBefore, seqAfter: auditAfter.json?.entries?.[0]?.seq });
    const simApprove = await post(`/v1/intents/${sim.json.decision.intentId}/approve`, { approver: 'alice' });
    check('approving a simulated quorum decision 404s', simApprove.status === 404, simApprove.json);

    // ---- 8. roster (v0.28.0): only roster members count toward quorum ----
    const rAgent = 'quorum-roster';
    const roster = ['alice', 'bob', 'carol'];
    const rPut = await put(`/v1/policies/${rAgent}`, basePolicy(rAgent, {
      quorumApprovals: 2,
      quorumAboveIssueQtyBaseUnits: '50000',
      quorumApprovers: roster,
      allowedDestinations: [wallet],
    }));
    check('roster policy stores', rPut.status === 200, rPut.json);
    const rHold = await post('/v1/assets/issue', {
      agentId: rAgent, name: 'ROSTERCOIN', qty: '60000', toAddress: wallet,
    });
    check('roster hold raised (202)',
      rHold.status === 202 && rHold.json?.decision?.kind === 'REQUIRE_APPROVAL', rHold.json);
    check('hold decision snapshots the roster (M=3) with quorumRequired 2',
      rHold.json?.decision?.quorumRequired === 2 &&
      JSON.stringify(rHold.json?.decision?.quorumApprovers) === JSON.stringify(roster), rHold.json?.decision);
    const rPending = await get('/v1/intents/pending');
    check('pending hold reports n/N of M (0 approvals, quorumRequired 2, roster of 3)',
      rPending.json?.pending?.some((p: any) =>
        p.intent.id === rHold.json.intent.id &&
        p.decision.quorumRequired === 2 &&
        (p.decision.approvals ?? []).length === 0 &&
        p.decision.quorumApprovers?.length === 3) === true, rPending.json?.pending?.length);
    const outsider = await post(`/v1/intents/${rHold.json.intent.id}/approve`, { approver: 'mallory' });
    check('an approver outside the roster gets 403 with 0/2 of 3',
      outsider.status === 403 && outsider.json?.approvalsReceived === 0 &&
      outsider.json?.approvalsRequired === 2 && outsider.json?.approversTotal === 3, outsider.json);
    const rPending2 = await get('/v1/intents/pending');
    check('rejected outsider approval leaves the hold pending with no approvals recorded',
      rPending2.json?.pending?.some((p: any) =>
        p.intent.id === rHold.json.intent.id && (p.decision.approvals ?? []).length === 0) === true);
    const rFirst = await post(`/v1/intents/${rHold.json.intent.id}/approve`, { approver: 'alice' });
    check('first roster approval is 202 with 1/2 of 3',
      rFirst.status === 202 && rFirst.json?.approvalsReceived === 1 &&
      rFirst.json?.approvalsRequired === 2 && rFirst.json?.approversTotal === 3 &&
      rFirst.json?.txid === undefined, rFirst.json);
    const rDup = await post(`/v1/intents/${rHold.json.intent.id}/approve`, { approver: 'alice' });
    check('same roster approver twice still counts 1 (alreadyCounted, 1/2 of 3)',
      rDup.status === 202 && rDup.json?.approvalsReceived === 1 && rDup.json?.alreadyCounted === true &&
      rDup.json?.approversTotal === 3, rDup.json);
    // The stored decision is the authority: swap the policy roster after
    // the hold, and the hold's original roster still governs.
    const rPut2 = await put(`/v1/policies/${rAgent}`, basePolicy(rAgent, {
      quorumApprovals: 2,
      quorumAboveIssueQtyBaseUnits: '50000',
      quorumApprovers: ['dave', 'erin', 'frank'],
      allowedDestinations: [wallet],
    }));
    check('policy roster swapped after the hold', rPut2.status === 200, rPut2.json);
    const rStale = await post(`/v1/intents/${rHold.json.intent.id}/approve`, { approver: 'dave' });
    check('an approver on the NEW roster but not the hold roster still gets 403',
      rStale.status === 403 && rStale.json?.approvalsReceived === 1, rStale.json);
    const rSecond = await post(`/v1/intents/${rHold.json.intent.id}/approve`, { approver: 'carol' });
    check('second roster approver executes (200, txid, 2/2 of 3)',
      rSecond.status === 200 && !!rSecond.json?.txid &&
      rSecond.json?.approvalsReceived === 2 && rSecond.json?.approvalsRequired === 2 &&
      rSecond.json?.approversTotal === 3, rSecond.json);
    // A deny by a non-roster approver still ends a quorum hold outright:
    // the roster gates approvals toward quorum, not the single-approver
    // deny.
    const rDoomed = await post('/v1/assets/issue', {
      agentId: rAgent, name: 'ROSTERDOOM', qty: '60000', toAddress: wallet,
    });
    check('second roster hold raised', rDoomed.status === 202 && rDoomed.json?.decision?.quorumRequired === 2, rDoomed.json);
    const rDenied = await post(`/v1/intents/${rDoomed.json.intent.id}/deny`, { approver: 'mallory' });
    check('a deny by a non-roster approver still ends the hold',
      rDenied.status === 200 && rDenied.json?.denied === true, rDenied.json);
    // Simulate reports the roster with zero side effects.
    const simRoster = await post('/v1/intents/simulate', {
      op: 'issue', agentId: rAgent, assetName: 'SIMROSTER', qty: '60000', destination: wallet,
    });
    check('simulate reports the roster hold (quorumRequired 2, roster of 3)',
      simRoster.json?.simulated === true && simRoster.json?.decision?.kind === 'REQUIRE_APPROVAL' &&
      simRoster.json?.decision?.quorumRequired === 2 &&
      JSON.stringify(simRoster.json?.decision?.quorumApprovers) === JSON.stringify(['dave', 'erin', 'frank']),
      simRoster.json);

    // ---- Audit chain still valid ----
    const audit = await get('/v1/audit?limit=200');
    check('audit chain valid after quorum operations', audit.json?.chainValid === true, audit.json?.chainValid);
  } finally {
    api.kill();
  }
  console.log(failures === 0 ? 'quorum-test: all green' : `quorum-test: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
