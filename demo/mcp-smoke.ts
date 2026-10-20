/**
 * MCP smoke test: speaks JSON-RPC 2.0 over stdio to src/mcp.ts against a
 * running API (MOCK_RVN default) and asserts:
 *   1. initialize handshake returns the protocol version + tool capability
 *   2. tools/list exposes issue_asset / transfer_asset / list_assets / get_audit
 *   3. tools/call list_assets returns an assets array
 *   4. tools/call get_audit returns a valid chain
 *   5. tools/call with an unknown tool returns isError
 *   6. an unknown method returns JSON-RPC -32601
 *   7-8. approve flow: transfer -> held -> pending -> approve -> gone from pending
 *   9. approve error paths (re-approve 409, unknown intent 404)
 *   10. deny flow: hold -> deny_intent -> approving the denied intent is 409
 *   11. policy tools: get/set round-trip, version rejection
 *
 * Usage: pnpm mcp-smoke   (API must be running, default http://localhost:3001)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

// Run from the repo root (pnpm mcp-smoke).
const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');
const API = process.env.API_URL ?? 'http://localhost:3001';

let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
let child: ChildProcess;
let shuttingDown = false;

function send(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function sendNotification(method: string): void {
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

function check(name: string, cond: boolean, detail?: unknown): void {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exitCode = 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

async function main(): Promise<void> {
  // The API must be reachable before we start.
  const health = await fetch(`${API}/v1/health`).then((r) => r.json()).catch(() => null);
  check('API is running', !!health, health);

  child = spawn(tsx, [join(repo, 'src', 'mcp.ts')], {
    env: { ...process.env, RVN_API_URL: API },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as any;
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  child.on('exit', (code) => {
    if (shuttingDown) return; // child.kill() after the last check — expected
    if (code !== 0 && code !== null) {
      console.error(`FAIL: MCP server exited with code ${code}`);
      process.exitCode = 1;
    }
  });

  // 1. handshake
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'mcp-smoke', version: '0.1.0' },
  });
  check('initialize returns protocolVersion', init.result?.protocolVersion === '2024-11-05', init);
  check('initialize advertises tools capability', !!init.result?.capabilities?.tools, init.result);
  sendNotification('notifications/initialized');

  // 2. tools/list
  const list = await send('tools/list');
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  for (const want of ['issue_asset', 'transfer_asset', 'list_assets', 'get_audit']) {
    check(`tools/list includes ${want}`, names.includes(want), names);
  }

  // 3. list_assets
  const assets = await send('tools/call', { name: 'list_assets', arguments: {} });
  const assetsBody = JSON.parse(assets.result.content[0].text);
  check('list_assets returns assets array', Array.isArray(assetsBody.assets), assetsBody);
  check('list_assets is not an error', !assets.result.isError);

  // 4. get_audit
  const audit = await send('tools/call', { name: 'get_audit', arguments: { limit: 10 } });
  const auditBody = JSON.parse(audit.result.content[0].text);
  check('get_audit returns valid chain', auditBody.chainValid === true, auditBody);
  check('get_audit returns entries', Array.isArray(auditBody.entries), auditBody);

  // 5. unknown tool -> isError
  const bad = await send('tools/call', { name: 'nope', arguments: {} });
  check('unknown tool returns isError', bad.result?.isError === true, bad.result);

  // 6. unknown method -> -32601
  const unknown = await send('bogus/method');
  check('unknown method returns -32601', unknown.error?.code === -32601, unknown);

  // 7. tools/list exposes the remainder tools
  for (const want of ['approve_intent', 'pending_intents', 'get_policy', 'set_policy']) {
    check(`tools/list includes ${want}`, names.includes(want), names);
  }

  // 8. full MCP approval flow: issue -> transfer (held) -> pending -> approve
  async function toolCall(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: any }> {
    const r = await send('tools/call', { name, arguments: args });
    return { ok: !r.result?.isError, body: JSON.parse(r.result.content[0].text) };
  }
  const agent = 'mcp-smoke-agent';
  const coin = `SMOKEMCP${Date.now() % 1_000_000}`;
  const walletA = (await (await fetch(`${API}/v1/wallets`, { method: 'POST' })).json() as any).address as string;
  const walletB = (await (await fetch(`${API}/v1/wallets`, { method: 'POST' })).json() as any).address as string;
  check('provisioned two wallets', !!walletA && !!walletB);

  // Allowlist the issue destination only, so the issue executes (ALLOW) but the
  // transfer to the other wallet is held (REQUIRE_APPROVAL). Also dogfoods set_policy.
  const seedPolicy = await toolCall('get_policy', { agentId: agent });
  const seed = await toolCall('set_policy', {
    agentId: agent,
    policy: { ...seedPolicy.body, agentId: agent, allowedDestinations: [walletA] },
  });
  check('set_policy allowlisted the issue wallet', seed.ok && seed.body.httpStatus === 200, seed.body);

  const issue = await toolCall('issue_asset', { agentId: agent, name: coin, qty: '500', toAddress: walletA });
  check('issue_asset via MCP is ALLOW', issue.ok && issue.body.decision?.kind === 'ALLOW', issue.body);

  // Transfer to an unallowlisted destination -> REQUIRE_APPROVAL (202, not an error).
  const held = await toolCall('transfer_asset', { agentId: agent, assetName: coin, qty: '100', destination: walletB });
  const intentId: string | undefined = held.body.intent?.id;
  check('transfer_asset held for approval', held.ok && held.body.decision?.kind === 'REQUIRE_APPROVAL' && !!intentId, held.body);

  const pend1 = await toolCall('pending_intents', {});
  check('pending_intents lists the held intent', pend1.ok && pend1.body.pending?.some((p: any) => p.intent.id === intentId), pend1.body);

  const approve = await toolCall('approve_intent', { intentId, approver: 'mcp-smoke' });
  check('approve_intent executes the transfer', approve.ok && !!approve.body.txid, approve.body);

  const pendingAfter = await toolCall('pending_intents', {});
  check('held intent gone from pending_intents', pendingAfter.ok && !pendingAfter.body.pending?.some((p: any) => p.intent.id === intentId), pendingAfter.body);

  // 9. approve error paths surface as isError
  const double = await toolCall('approve_intent', { intentId });
  check('re-approving returns isError (409)', !double.ok && double.body.httpStatus === 409, double.body);
  const unknownIntent = await toolCall('approve_intent', { intentId: '00000000-0000-0000-0000-000000000000' });
  check('approving unknown intent returns isError (404)', !unknownIntent.ok && unknownIntent.body.httpStatus === 404, unknownIntent.body);

  // 10. deny flow
  const held2 = await toolCall('transfer_asset', { agentId: agent, assetName: coin, qty: '100', destination: walletB });
  const denyId: string | undefined = held2.body.intent?.id;
  check('second transfer held for approval', held2.ok && held2.body.decision?.kind === 'REQUIRE_APPROVAL' && !!denyId, held2.body);
  const denied = await toolCall('deny_intent', { intentId: denyId, approver: 'mcp-smoke' });
  check('deny_intent denies the held intent', denied.ok && denied.body.denied === true, denied.body);
  const approveDenied = await toolCall('approve_intent', { intentId: denyId });
  check('approving a denied intent returns isError (409)', !approveDenied.ok && approveDenied.body.httpStatus === 409, approveDenied.body);

  // 11. policy tools
  const got = await toolCall('get_policy', { agentId: agent });
  check('get_policy returns a v1 policy', got.ok && got.body.version === 1, got.body);
  const put = await toolCall('set_policy', { agentId: agent, policy: { ...got.body, agentId: agent } });
  check('set_policy round-trips the policy', put.ok && put.body.httpStatus === 200 && put.body.policy?.agentId === agent, put.body);
  const badPolicy = await toolCall('set_policy', { agentId: agent, policy: { version: 2 } });
  check('set_policy rejects version:2 (400)', !badPolicy.ok && badPolicy.body.httpStatus === 400, badPolicy.body);

  child.kill();
  shuttingDown = true;
  console.log(process.exitCode ? 'MCP smoke: FAILED' : 'MCP smoke: all green');
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
