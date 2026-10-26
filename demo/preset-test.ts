/**
 * preset-test: checks for the policy presets gallery.
 *
 *  pnpm test:presets
 *
 * Boots the real API as a child process (MOCK_RVN=true) and asserts:
 *   - GET /v1/policies/presets lists conservative / balanced / permissive
 *     with descriptions and full policy documents (agentId '*')
 *   - POST /v1/policies/:agentId/preset applies a preset wholesale and the
 *     agent's policy then reads back with those values
 *   - an applied preset actually gates: conservative denies over-cap issues
 *   - per-agent overrides merge over the preset (other fields untouched)
 *     and the merged policy gates accordingly
 *   - permissive's wildcard allowlist lets unknown destinations ALLOW
 *   - unknown preset / unknown override field / malformed override values /
 *     non-object overrides / missing preset all 400 and store nothing
 *   - an assetNamePattern override is enforced by the policy engine
 *   - the audit chain stays valid
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3127;
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

async function main(): Promise<void> {
  const api = await bootApi();
  try {
    // ---- Gallery listing ----
    const list = await get('/v1/policies/presets');
    check('GET /v1/policies/presets is 200', list.status === 200, list);
    const presets = list.json?.presets ?? [];
    check('gallery lists exactly 3 presets', presets.length === 3, presets);
    check(
      'preset ids are conservative / balanced / permissive in order',
      presets.map((p: any) => p.id).join(',') === 'conservative,balanced,permissive',
      presets.map((p: any) => p.id),
    );
    check(
      'every preset has a description and a version:1 policy with agentId *',
      presets.every(
        (p: any) =>
          typeof p.description === 'string' && p.description.length > 0 &&
          p.policy?.version === 1 && p.policy?.agentId === '*',
      ),
      presets,
    );
    const byId = Object.fromEntries(presets.map((p: any) => [p.id, p.policy]));
    check(
      'caps order conservative < balanced < permissive',
      BigInt(byId.conservative.maxIssueQtyBaseUnits) < BigInt(byId.balanced.maxIssueQtyBaseUnits) &&
        BigInt(byId.balanced.maxIssueQtyBaseUnits) < BigInt(byId.permissive.maxIssueQtyBaseUnits),
      byId,
    );
    check('permissive allowlists everything, others allowlist nothing',
      byId.permissive.allowedDestinations.includes('*') &&
        byId.conservative.allowedDestinations.length === 0 &&
        byId.balanced.allowedDestinations.length === 0,
      byId,
    );

    // A wallet address to use as an allowlisted destination.
    const wallet = (await post('/v1/wallets', {})).json?.address as string;
    check('wallet provisioned for allowlist tests', typeof wallet === 'string' && wallet.length > 0, wallet);

    // ---- Apply conservative, wholesale ----
    const cons = await post('/v1/policies/cons-agent/preset', { preset: 'conservative' });
    check('apply conservative is 200 with preset + policy', cons.status === 200 && cons.json?.preset === 'conservative', cons);
    check('applied policy carries the route agentId', cons.json?.policy?.agentId === 'cons-agent', cons.json?.policy);
    const consBack = await get('/v1/policies/cons-agent');
    check('conservative policy reads back (cap 10000, threshold 1000, budget 50000, ttl 60)',
      consBack.json?.maxIssueQtyBaseUnits === '10000' &&
        consBack.json?.approvalAboveIssueQtyBaseUnits === '1000' &&
        consBack.json?.dailyIssueBudgetBaseUnits === '50000' &&
        consBack.json?.decisionTtlSeconds === 60,
      consBack.json,
    );
    const overCap = await post('/v1/assets/issue', { agentId: 'cons-agent', name: 'PRESETCOIN', qty: '20000', toAddress: wallet });
    check('conservative denies an over-cap issue (403 ISSUE_CAP_EXCEEDED)',
      overCap.status === 403 && overCap.json?.decision?.reasonCodes?.includes('ISSUE_CAP_EXCEEDED'), overCap);

    // ---- Apply balanced with per-agent overrides ----
    const bal = await post('/v1/policies/bal-agent/preset', {
      preset: 'balanced',
      overrides: { allowedDestinations: [wallet], approvalAboveIssueQtyBaseUnits: '2000' },
    });
    check('apply balanced with overrides is 200', bal.status === 200, bal);
    check('overrides land, untouched preset fields stay (cap 100000, budget 500000)',
      bal.json?.policy?.allowedDestinations?.includes(wallet) &&
        bal.json?.policy?.approvalAboveIssueQtyBaseUnits === '2000' &&
        bal.json?.policy?.maxIssueQtyBaseUnits === '100000' &&
        bal.json?.policy?.dailyIssueBudgetBaseUnits === '500000',
      bal.json?.policy,
    );
    const small = await post('/v1/assets/issue', { agentId: 'bal-agent', name: 'BALCOIN', qty: '500', toAddress: wallet });
    check('allowlisted + below overridden threshold ALLOWs with txid',
      small.status === 200 && small.json?.decision?.kind === 'ALLOW' && !!small.json?.txid, small);
    const above = await post('/v1/assets/issue', { agentId: 'bal-agent', name: 'BALCOIN2', qty: '5000', toAddress: wallet });
    check('allowlisted + above overridden threshold holds (202 REQUIRE_APPROVAL)',
      above.status === 202 && above.json?.decision?.kind === 'REQUIRE_APPROVAL', above);

    // ---- Apply permissive: wildcard allowlist in action ----
    const perm = await post('/v1/policies/perm-agent/preset', { preset: 'permissive' });
    check('apply permissive is 200 with wildcard allowlist + ttl 3600',
      perm.status === 200 && perm.json?.policy?.allowedDestinations?.includes('*') &&
        perm.json?.policy?.decisionTtlSeconds === 3600,
      perm.json?.policy,
    );
    const permIssue = await post('/v1/assets/issue', { agentId: 'perm-agent', name: 'PERMCOIN', qty: '500000', toAddress: 'some-unknown-address' });
    check('permissive ALLOWs a mid-size issue to an unknown destination',
      permIssue.status === 200 && permIssue.json?.decision?.kind === 'ALLOW', permIssue);

    // ---- Rejection paths store nothing ----
    const badPreset = await post('/v1/policies/bad-agent/preset', { preset: 'nonexistent' });
    check('unknown preset -> 400', badPreset.status === 400 && /unknown preset/.test(badPreset.json?.error ?? ''), badPreset);
    const badAfter = await get('/v1/policies/bad-agent');
    check('failed apply leaves the agent on the default policy (cap 100000)',
      badAfter.json?.maxIssueQtyBaseUnits === '100000', badAfter.json);
    const badField = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: { nope: '1' } });
    check('unknown override field -> 400', badField.status === 400 && /unknown override field/.test(badField.json?.error ?? ''), badField);
    const badQty = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: { maxIssueQtyBaseUnits: 'abc' } });
    check('non-numeric qty override -> 400', badQty.status === 400, badQty);
    const badQtyNeg = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: { maxIssueQtyBaseUnits: '-5' } });
    check('negative qty override -> 400', badQtyNeg.status === 400, badQtyNeg);
    const badTtl = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: { decisionTtlSeconds: 0 } });
    check('non-positive ttl override -> 400', badTtl.status === 400, badTtl);
    const badPattern = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: { assetNamePattern: '([' } });
    check('invalid regex override -> 400', badPattern.status === 400, badPattern);
    const badList = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: { allowedDestinations: 'not-an-array' } });
    check('non-array destination override -> 400', badList.status === 400, badList);
    const badShape = await post('/v1/policies/bad-agent/preset', { preset: 'balanced', overrides: ['x'] });
    check('array overrides -> 400', badShape.status === 400, badShape);
    const missing = await post('/v1/policies/bad-agent/preset', {});
    check('missing preset -> 400', missing.status === 400, missing);
    const badAfterAll = await get('/v1/policies/bad-agent');
    check('all failed applies left the agent on the default policy',
      badAfterAll.json?.maxIssueQtyBaseUnits === '100000', badAfterAll.json);

    // ---- assetNamePattern override is enforced ----
    const pat = await post('/v1/policies/pat-agent/preset', {
      preset: 'conservative',
      overrides: { assetNamePattern: '^[A-Z]{3,5}$', allowedDestinations: [wallet] },
    });
    check('pattern override applies', pat.status === 200 && pat.json?.policy?.assetNamePattern === '^[A-Z]{3,5}$', pat.json?.policy);
    const simLong = await post('/v1/intents/simulate', { op: 'issue', agentId: 'pat-agent', assetName: 'TOOLONGNAME', qty: '10', destination: wallet });
    check('simulate: too-long name DENYs ASSET_NAME_REJECTED under the override',
      simLong.json?.decision?.kind === 'DENY' && simLong.json?.decision?.reasonCodes?.includes('ASSET_NAME_REJECTED'), simLong);
    const simShort = await post('/v1/intents/simulate', { op: 'issue', agentId: 'pat-agent', assetName: 'ABC', qty: '10', destination: wallet });
    check('simulate: short name passes the pattern (ALLOW)',
      simShort.json?.decision?.kind === 'ALLOW', simShort);

    // ---- Audit chain still valid ----
    const audit = await get('/v1/audit?limit=200');
    check('audit chain valid after preset operations', audit.json?.chainValid === true, audit.json?.chainValid);
  } finally {
    api.kill();
  }
  console.log(failures === 0 ? 'preset-test: all green' : `preset-test: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
