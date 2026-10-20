/**
 * Demo: the Phase-0 loop against the mock node.
 *
 *  1. Start the API:  pnpm dev        (MOCK_RVN=true by default)
 *  2. Run this:       pnpm demo
 *
 * Exercises:
 *   - policy update (allowlist the agent wallet)
 *   - issue within policy            -> ALLOW
 *   - issue above the per-op cap     -> DENY
 *   - asset name violating policy    -> DENY
 *   - transfer to unknown address    -> REQUIRE_APPROVAL -> approve -> executed
 * Then lists assets and verifies the audit chain.
 */
const API = process.env.API_URL ?? 'http://localhost:3001';

async function post(path: string, body: unknown, expect?: number) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  const tag = expect && res.status !== expect ? ` (UNEXPECTED, wanted ${expect})` : '';
  console.log(`POST ${path} -> ${res.status}${tag}`);
  return { status: res.status, json };
}

async function put(path: string, body: unknown, expect?: number) {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  const tag = expect && res.status !== expect ? ` (UNEXPECTED, wanted ${expect})` : '';
  console.log(`PUT ${path} -> ${res.status}${tag}`);
  return { status: res.status, json };
}

async function get(path: string) {
  const res = await fetch(`${API}${path}`);
  return (await res.json()) as any;
}

async function main() {
  const health = await get('/v1/health');
  console.log('health:', JSON.stringify(health));

  const { address } = (await post('/v1/wallets', {}, 200)).json;
  console.log('provisioned agent wallet:', address);

  console.log('--- 0. allowlist the agent wallet in policy ---');
  const policy = await get('/v1/policies/agent-1');
  await put('/v1/policies/agent-1', { ...policy, agentId: 'agent-1', allowedDestinations: [address] }, 200);
  console.log('   policy updated.');

  console.log('--- 1. issue 1,000 DEMOCOIN (expect ALLOW) ---');
  const r1 = await post('/v1/assets/issue', {
    agentId: 'agent-1', name: 'DEMOCOIN', qty: '1000', toAddress: address,
  }, 200);
  console.log('   decision:', r1.json.decision?.kind, '| reasons:', r1.json.decision?.reasonCodes);

  console.log('--- 2. issue 500,000 DEMOCOIN2 (expect DENY: over per-op cap) ---');
  const r2 = await post('/v1/assets/issue', {
    agentId: 'agent-1', name: 'DEMOCOIN2', qty: '500000', toAddress: address,
  }, 403);
  console.log('   decision:', r2.json.decision?.kind, '| reasons:', r2.json.decision?.reasonCodes);

  console.log('--- 3. issue "bad name!!" (expect DENY: name rejected) ---');
  const r3 = await post('/v1/assets/issue', {
    agentId: 'agent-1', name: 'bad name!!', qty: '100', toAddress: address,
  }, 403);
  console.log('   decision:', r3.json.decision?.kind, '| reasons:', r3.json.decision?.reasonCodes);

  console.log('--- 4. transfer 100 DEMOCOIN to unknown address (expect REQUIRE_APPROVAL) ---');
  const r4 = await post('/v1/assets/transfer', {
    agentId: 'agent-1', assetName: 'DEMOCOIN', qty: '100', destination: 'mtest1stranger000001xxxxxxxxxxxx',
  }, 202);
  const intentId = r4.json.intent?.id;
  console.log('   decision:', r4.json.decision?.kind, '| reasons:', r4.json.decision?.reasonCodes);

  if (intentId) {
    console.log('--- 5. human approves the held transfer ---');
    const r5 = await post(`/v1/intents/${intentId}/approve`, { approver: 'paul' }, 200);
    console.log('   approved. txid:', r5.json.txid, '| mock:', r5.json.mock);
  }

  console.log('--- 6. list assets ---');
  const assets = await get('/v1/assets');
  console.log('   assets:', assets.assets.map((a: any) => `${a.name} (${a.amount})`).join(', '));

  console.log('--- 7. audit trail ---');
  const audit = await get('/v1/audit?limit=20');
  console.log('   chain valid:', audit.chainValid, '| entries:', audit.entries.length);
  for (const e of audit.entries) {
    console.log(`   #${e.seq} ${e.kind} intent=${e.intentId.slice(0, 8)}…`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
