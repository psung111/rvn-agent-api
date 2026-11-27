/**
 * mcp-auth-test: checks for MCP server API-key passthrough (v0.30.0,
 * slice 2 of the API-key authentication item).
 *
 *  pnpm test:mcp-auth
 *
 * Boots the real API as a child process (MOCK_RVN=true, auth ON via
 * RVN_AUTH_ENABLED=true + RVN_OPERATOR_API_KEY) and asserts:
 *   - with RVN_API_KEY set to an issued per-agent key, the MCP server
 *     proxies tools through the gate: list_assets works, issue_asset
 *     ALLOWs as the key's agent, and acting as another agent 403s
 *     (surfaced as isError, with the key's agent the default only when
 *     the tool caller omits agentId — the MCP tools send 'agent-1'
 *     unless told otherwise, so callers must pass the key's agent)
 *   - with no RVN_API_KEY, and with a wrong key, every tool call 401s
 *     and surfaces as isError (including the submit tools, which used
 *     to treat only 403/429 as errors)
 *   - the MCP server never logs the key (its stderr is captured and
 *     asserted key-free)
 *   - the audit chain stays valid throughout
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API_PORT = 3131;
const API = `http://127.0.0.1:${API_PORT}`;
const OPERATOR_KEY = 'rvn_operator-testkey-0123456789abcdef';
const AGENT = 'mcp-auth-agent';
const DEST = 'RXmcpAuth1111111111111111111111';

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
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MOCK_RVN: 'true',
      RVN_AUTH_ENABLED: 'true',
      RVN_OPERATOR_API_KEY: OPERATOR_KEY,
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

async function stopApi(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
}

async function req(method: string, path: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
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

function basePolicy(agentId: string) {
  return {
    version: 1,
    agentId,
    maxIssueQtyBaseUnits: '100000',
    approvalAboveIssueQtyBaseUnits: '10000',
    dailyIssueBudgetBaseUnits: '500000',
    maxTransferQtyBaseUnits: '50000',
    approvalAboveTransferQtyBaseUnits: '5000',
    allowedDestinations: [DEST],
    blockedDestinations: [],
    assetNamePattern: '^[A-Z0-9._]{3,30}$',
    decisionTtlSeconds: 3600,
  };
}

// --- MCP child plumbing (stdio JSON-RPC, stderr captured) -------------

interface McpHandle {
  child: ChildProcess;
  stderr: string;
  send: (method: string, params?: unknown) => Promise<any>;
  kill: () => void;
}

async function spawnMcp(extraEnv: Record<string, string>): Promise<McpHandle> {
  const child = spawn(tsx, [join(repo, 'src', 'mcp.ts')], {
    env: { ...process.env, RVN_API_URL: API, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  let nextId = 1;
  const pending = new Map<number, (msg: any) => void>();
  let buf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
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
  const send = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    child,
    get stderr() {
      return stderr;
    },
    send,
    kill: () => child.kill(),
  };
}

async function toolCall(
  mcp: McpHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; body: any }> {
  const r = await mcp.send('tools/call', { name, arguments: args });
  return { ok: !r.result?.isError, body: JSON.parse(r.result.content[0].text) };
}

async function main() {
  const api = await bootApi();
  try {
    // Operator issues a per-agent key and sets that agent's policy.
    const issued = await req('POST', '/v1/admin/api-keys', { agentId: AGENT }, OPERATOR_KEY);
    check('operator issues a key for the MCP agent',
      issued.status === 200 && typeof issued.json?.key === 'string', issued);
    const agentKey = issued.json.key as string;
    const policy = await req('PUT', `/v1/policies/${AGENT}`, basePolicy(AGENT), OPERATOR_KEY);
    check('operator sets the MCP agent policy', policy.status === 200, policy);

    // --- 1. MCP with the agent key ---
    const keyed = await spawnMcp({ RVN_API_KEY: agentKey });
    try {
      const init = await keyed.send('initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'mcp-auth-test', version: '0.1.0' },
      });
      check('initialize reports server version 0.43.0',
        init.result?.serverInfo?.version === '0.43.0', init.result?.serverInfo);
      keyed.child.stdin!.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );

      const assets = await toolCall(keyed, 'list_assets', {});
      check('keyed MCP list_assets works', assets.ok && Array.isArray(assets.body.assets), assets.body);

      const issue = await toolCall(keyed, 'issue_asset', {
        agentId: AGENT, name: 'MCPKEYCOIN', qty: '100', toAddress: DEST,
      });
      check('keyed MCP issue as the key agent ALLOWs',
        issue.ok && issue.body.decision?.kind === 'ALLOW' && !!issue.body.txid, issue.body);

      const other = await toolCall(keyed, 'issue_asset', {
        agentId: 'agent-1', name: 'MCPKEYCOIN2', qty: '100', toAddress: DEST,
      });
      check('keyed MCP acting as another agent 403s as an error',
        !other.ok && other.body.httpStatus === 403, other.body);

      const policyOk = await toolCall(keyed, 'get_policy', { agentId: AGENT });
      check('keyed MCP reads its own policy',
        policyOk.ok && policyOk.body.agentId === AGENT, policyOk.body);
      const policyOther = await toolCall(keyed, 'get_policy', { agentId: 'agent-1' });
      check('keyed MCP reading another agent policy 403s as an error',
        !policyOther.ok && policyOther.body.httpStatus === 403, policyOther.body);

      // Give the stderr buffer a beat to flush, then assert the key
      // never appeared in the server's own logs.
      await new Promise((r) => setTimeout(r, 200));
      check('MCP stderr never contains the raw key', !keyed.stderr.includes(agentKey), keyed.stderr);
    } finally {
      keyed.kill();
    }

    // --- 2. MCP with no key ---
    const nokey = await spawnMcp({});
    try {
      await nokey.send('initialize', { protocolVersion: '2024-11-05' });
      const assets = await toolCall(nokey, 'list_assets', {});
      check('keyless MCP list_assets 401s as an error',
        !assets.ok && assets.body.httpStatus === 401, assets.body);
      const issue = await toolCall(nokey, 'issue_asset', {
        agentId: AGENT, name: 'MCPNOKEY', qty: '100', toAddress: DEST,
      });
      check('keyless MCP issue_asset 401s as an error (not a success-shaped payload)',
        !issue.ok && issue.body.httpStatus === 401, issue.body);
      const transfer = await toolCall(nokey, 'transfer_asset', {
        agentId: AGENT, assetName: 'MCPKEYCOIN', qty: '10', destination: DEST,
      });
      check('keyless MCP transfer_asset 401s as an error',
        !transfer.ok && transfer.body.httpStatus === 401, transfer.body);
    } finally {
      nokey.kill();
    }

    // --- 3. MCP with a wrong key ---
    const wrong = await spawnMcp({ RVN_API_KEY: 'rvn_00000000000000000000000000000000' });
    try {
      await wrong.send('initialize', { protocolVersion: '2024-11-05' });
      const assets = await toolCall(wrong, 'list_assets', {});
      check('wrong-key MCP list_assets 401s as an error',
        !assets.ok && assets.body.httpStatus === 401, assets.body);
    } finally {
      wrong.kill();
    }

    // --- 4. MCP with a read-only key (v0.31.0 scopes) ---
    const roIssued = await req('POST', '/v1/admin/api-keys', { agentId: AGENT, scopes: ['read'] }, OPERATOR_KEY);
    check('operator issues a read-only key for the MCP agent',
      roIssued.status === 200 && JSON.stringify(roIssued.json?.record?.scopes) === '["read"]', roIssued);
    const ro = await spawnMcp({ RVN_API_KEY: roIssued.json.key as string });
    try {
      await ro.send('initialize', { protocolVersion: '2024-11-05' });
      const assets = await toolCall(ro, 'list_assets', {});
      check('read-only MCP list_assets works', assets.ok && Array.isArray(assets.body.assets), assets.body);
      const issue = await toolCall(ro, 'issue_asset', {
        agentId: AGENT, name: 'MCPROCOIN', qty: '100', toAddress: DEST,
      });
      check('read-only MCP issue_asset 403s as an error (scope, not auth)',
        !issue.ok && issue.body.httpStatus === 403, issue.body);
      const policyOk = await toolCall(ro, 'get_policy', { agentId: AGENT });
      check('read-only MCP reads its own policy', policyOk.ok && policyOk.body.agentId === AGENT, policyOk.body);
    } finally {
      ro.kill();
    }

    // --- 5. Chain still valid ---
    const audit = await req('GET', '/v1/audit?limit=50', undefined, OPERATOR_KEY);
    check('audit chain stays valid', audit.json?.chainValid === true, audit.json);
  } finally {
    await stopApi(api);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
