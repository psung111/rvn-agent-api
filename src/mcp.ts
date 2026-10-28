/**
 * MCP server (stdio) for rvn-agent-api — complete.
 *
 * Exposes the policy-gated operations as MCP tools so AI agents (Claude,
 * Cursor, etc.) can call them natively instead of raw REST:
 *
 *   - issue_asset      -> POST /v1/assets/issue
 *   - issue_subasset   -> POST /v1/assets/issue-subasset
 *   - issue_unique     -> POST /v1/assets/issue-unique
 *   - reissue_asset    -> POST /v1/assets/reissue
 *   - transfer_asset   -> POST /v1/assets/transfer
 *   - simulate_intent  -> POST /v1/intents/simulate (dry run, no side effects)
 *   - approve_intent   -> POST /v1/intents/:id/approve
 *   - deny_intent      -> POST /v1/intents/:id/deny
 *   - pending_intents  -> GET  /v1/intents/pending
 *   - list_assets      -> GET  /v1/assets
 *   - get_audit        -> GET  /v1/audit (chain validity + entries)
 *   - get_policy       -> GET  /v1/policies/:agentId
 *   - set_policy       -> PUT  /v1/policies/:agentId
 *   - list_presets     -> GET  /v1/policies/presets
 *   - apply_preset     -> POST /v1/policies/:agentId/preset
 *
 * The MCP server is only a transport: the REST API stays the single
 * enforcement point — every tool call runs through the policy engine and the
 * hash-chained audit exactly as a REST call would.
 *
 * Wire it into a client config:
 *
 *   "rvn-agent-api": {
 *     "command": "pnpm",
 *     "args": ["--dir", "/path/to/rvn-agent-api", "mcp"],
 *     "env": { "RVN_API_URL": "http://127.0.0.1:3001" }
 *   }
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio (the stdio framing the
 * MCP TypeScript SDK uses). Speaks initialize / tools/list / tools/call /
 * ping; everything else answers -32601 (method not found).
 */

const API = process.env.RVN_API_URL ?? 'http://127.0.0.1:3001';
const PROTOCOL_VERSION = '2024-11-05';

const log = (...args: unknown[]) => console.error('[mcp]', ...args);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'issue_asset',
    description:
      'Issue a new Ravencoin asset through the policy engine. Returns the policy decision (ALLOW/DENY/REQUIRE_APPROVAL) and, when executed, the txid. Nothing touches chain: the node is a mock unless RVN is wired live.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Asset name, e.g. DEMOCOIN' },
        qty: { type: 'string', description: 'Quantity in base units (decimal string)' },
        toAddress: { type: 'string', description: 'Destination address' },
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        units: { type: 'number', description: 'Decimal places (default 0)' },
        reissuable: { type: 'boolean', description: 'Whether the asset can be reissued (default true)' },
        ipfsHash: { type: 'string', description: 'Optional IPFS/Txid hash attached to the asset' },
      },
      required: ['name', 'qty', 'toAddress'],
    },
  },
  {
    name: 'issue_subasset',
    description:
      'Issue a sub-asset under an existing parent Ravencoin asset through the policy engine ' +
      '(POST /v1/assets/issue-subasset). The name is PARENT/SUB (nested PARENT/CHILD/GRAND works ' +
      'when the immediate parent exists); policy treats it like an issue — same per-op cap, 24h ' +
      'issue budget, approval threshold, and destination allowlist — with the asset-name pattern ' +
      'applied to every slash-separated segment. Fails on an unknown parent asset.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sub-asset name, e.g. MYCOIN/REWARDS (parent must exist)' },
        qty: { type: 'string', description: 'Quantity in base units (decimal string)' },
        toAddress: { type: 'string', description: 'Destination address' },
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        units: { type: 'number', description: 'Decimal places (default 0)' },
        reissuable: { type: 'boolean', description: 'Whether the sub-asset can be reissued (default true)' },
        ipfsHash: { type: 'string', description: 'Optional IPFS/Txid hash attached to the sub-asset' },
      },
      required: ['name', 'qty', 'toAddress'],
    },
  },
  {
    name: 'issue_unique',
    description:
      'Issue a unique Ravencoin asset (NFT) under an existing root asset through the policy engine ' +
      '(POST /v1/assets/issue-unique). The name is ROOT#TAG (the root may itself be a sub-asset, ' +
      'e.g. ART/DAVINCI#MONALISA); policy treats it like an issue — same per-op cap, 24h ' +
      'issue budget, approval threshold, and destination allowlist — with the asset-name pattern ' +
      'applied to the root and the tag checked separately. A unique asset is a singleton ' +
      '(amount 1, units 0, never reissuable), so qty is fixed at 1. Fails on an unknown root asset.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique asset name, e.g. MYCOIN#SERIAL001 (root must exist)' },
        toAddress: { type: 'string', description: 'Destination address' },
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        qty: { type: 'string', description: 'Must be "1" when given (default 1 — unique assets are singletons)' },
        ipfsHash: { type: 'string', description: 'Optional IPFS/Txid hash attached to the unique asset' },
      },
      required: ['name', 'toAddress'],
    },
  },
  {
    name: 'reissue_asset',
    description:
      'Reissue additional supply of an existing reissuable Ravencoin asset through the policy engine ' +
      '(POST /v1/assets/reissue). Policy treats a reissue like an issue: same per-op cap, 24h issue ' +
      'budget, approval threshold, destination allowlist, and asset-name pattern. Returns the policy ' +
      'decision and, when executed, the txid. Fails on a non-reissuable or unknown asset.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Asset name, e.g. DEMOCOIN' },
        qty: { type: 'string', description: 'Additional quantity in base units (decimal string)' },
        toAddress: { type: 'string', description: 'Destination address for the new supply' },
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        reissuable: { type: 'boolean', description: 'Flip the reissuable flag on this reissue (optional)' },
        newUnits: { type: 'number', description: 'Replace the decimal places, 0..8 (optional)' },
        newIpfsHash: { type: 'string', description: 'Replace the IPFS/Txid hash; requires newUnits (optional)' },
      },
      required: ['name', 'qty', 'toAddress'],
    },
  },
  {
    name: 'transfer_asset',
    description:
      'Transfer an existing Ravencoin asset through the policy engine. Returns the policy decision and, when executed, the txid.',
    inputSchema: {
      type: 'object',
      properties: {
        assetName: { type: 'string', description: 'Asset name, e.g. DEMOCOIN' },
        qty: { type: 'string', description: 'Quantity in base units (decimal string)' },
        destination: { type: 'string', description: 'Destination address' },
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
      },
      required: ['assetName', 'qty', 'destination'],
    },
  },
  {
    name: 'simulate_intent',
    description:
      'Dry-run an issue, reissue, or transfer through the policy engine (POST /v1/intents/simulate). ' +
      'Returns the decision the policy WOULD make — ALLOW, REQUIRE_APPROVAL, or DENY — without ' +
      'storing the intent, recording issue spend, appending to the audit chain, notifying ' +
      'approvers, or executing anything. Use it to check an action before committing to it.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: "Operation to simulate: 'issue', 'reissue', or 'transfer'" },
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        assetName: { type: 'string', description: 'Asset name, e.g. MYCOIN (issue also accepts name)' },
        name: { type: 'string', description: 'Alias for assetName on issue' },
        qty: { type: 'string', description: 'Quantity in base units (decimal string)' },
        destination: { type: 'string', description: 'Destination address (issue also accepts toAddress)' },
        toAddress: { type: 'string', description: 'Alias for destination on issue' },
      },
      required: ['op', 'qty'],
    },
  },
  {
    name: 'approve_intent',
    description:
      'Approve a held REQUIRE_APPROVAL intent (POST /v1/intents/:id/approve). ' +
      'The API re-evaluates policy at approval time; a DENY on re-evaluation ' +
      'or an expired decision returns an error. Returns the execution txid on success.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string', description: 'Held intent id' },
        approver: { type: 'string', description: 'Approver label, recorded in the audit log (default: mcp-agent)' },
      },
      required: ['intentId'],
    },
  },
  {
    name: 'deny_intent',
    description:
      'Deny a held REQUIRE_APPROVAL intent (POST /v1/intents/:id/deny). ' +
      'The decision is marked DENY with reason code DENIED_BY_OWNER and the ' +
      'denial is recorded in the audit log; nothing executes.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string', description: 'Held intent id' },
        approver: { type: 'string', description: 'Denier label, recorded in the audit log (default: mcp-agent)' },
      },
      required: ['intentId'],
    },
  },
  {
    name: 'pending_intents',
    description:
      'List intents currently held for approval (non-expired REQUIRE_APPROVAL decisions).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_policy',
    description: 'Read the active policy for an agent (the agent-specific policy, or the "*" default).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
      },
    },
  },
  {
    name: 'set_policy',
    description:
      'Replace the policy for an agent (PUT /v1/policies/:agentId). The policy object ' +
      'must include version: 1 and every policy field; agentId is forced to match. ' +
      'Call get_policy first and edit the returned document to avoid clobbering fields.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        policy: {
          type: 'object',
          description: 'Full policy document: version (1), maxIssueQtyBaseUnits, approvalAboveIssueQtyBaseUnits, dailyIssueBudgetBaseUnits, maxTransferQtyBaseUnits, approvalAboveTransferQtyBaseUnits, allowedDestinations, blockedDestinations, assetNamePattern, decisionTtlSeconds.',
        },
      },
      required: ['policy'],
    },
  },
  {
    name: 'list_presets',
    description:
      'List the policy presets (GET /v1/policies/presets): conservative, balanced, and permissive, ' +
      'each with its full policy document. Apply one with apply_preset instead of hand-writing a policy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apply_preset',
    description:
      'Apply a policy preset to an agent (POST /v1/policies/:agentId/preset), optionally with ' +
      'per-agent overrides for any overridable field (caps, budgets, thresholds, destination ' +
      'lists, assetNamePattern, decisionTtlSeconds). Replaces the agent policy wholesale, like ' +
      'set_policy, and is audited as a policy replacement naming the preset.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent identity (default: agent-1)' },
        preset: { type: 'string', description: "Preset id: 'conservative', 'balanced', or 'permissive'" },
        overrides: {
          type: 'object',
          description: 'Optional per-agent overrides, e.g. { allowedDestinations: ["<address>"] }',
        },
      },
      required: ['preset'],
    },
  },
  {
    name: 'list_assets',
    description: 'List assets known to the node, optionally filtered by a glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. DEMO* (default *)' },
      },
    },
  },
  {
    name: 'get_audit',
    description: 'Read the tail of the hash-chained audit log and verify the chain.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
      },
    },
  },
];

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = { error: `non-JSON response (${res.status})` };
  }
  return { status: res.status, body };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'issue_asset': {
      const { status, body } = await api('/v1/assets/issue', {
        method: 'POST',
        body: JSON.stringify({
          agentId: args.agentId ?? 'agent-1',
          name: args.name,
          qty: args.qty,
          toAddress: args.toAddress,
          units: args.units,
          reissuable: args.reissuable,
          ipfsHash: args.ipfsHash,
        }),
      });
      const b = body as { decision?: { kind?: string } };
      const denied = status === 403 || b.decision?.kind === 'DENY';
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, denied);
    }
    case 'issue_unique': {
      const { status, body } = await api('/v1/assets/issue-unique', {
        method: 'POST',
        body: JSON.stringify({
          agentId: args.agentId ?? 'agent-1',
          name: args.name,
          qty: args.qty,
          toAddress: args.toAddress,
          ipfsHash: args.ipfsHash,
        }),
      });
      const b = body as { decision?: { kind?: string } };
      const denied = status === 403 || b.decision?.kind === 'DENY' || status >= 400;
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, denied);
    }
    case 'reissue_asset': {
      const { status, body } = await api('/v1/assets/reissue', {
        method: 'POST',
        body: JSON.stringify({
          agentId: args.agentId ?? 'agent-1',
          name: args.name,
          qty: args.qty,
          toAddress: args.toAddress,
          reissuable: args.reissuable,
          newUnits: args.newUnits,
          newIpfsHash: args.newIpfsHash,
        }),
      });
      const b = body as { decision?: { kind?: string } };
      const denied = status === 403 || b.decision?.kind === 'DENY';
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, denied);
    }
    case 'transfer_asset': {
      const { status, body } = await api('/v1/assets/transfer', {
        method: 'POST',
        body: JSON.stringify({
          agentId: args.agentId ?? 'agent-1',
          assetName: args.assetName,
          qty: args.qty,
          destination: args.destination,
        }),
      });
      const b = body as { decision?: { kind?: string } };
      const denied = status === 403 || b.decision?.kind === 'DENY';
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, denied);
    }
    case 'issue_subasset': {
      const { status, body } = await api('/v1/assets/issue-subasset', {
        method: 'POST',
        body: JSON.stringify({
          agentId: args.agentId ?? 'agent-1',
          name: args.name,
          qty: args.qty,
          toAddress: args.toAddress,
          units: args.units,
          reissuable: args.reissuable,
          ipfsHash: args.ipfsHash,
        }),
      });
      const b = body as { decision?: { kind?: string } };
      // A policy DENY (403) and a node failure (502, e.g. unknown parent)
      // are both errors for the caller.
      const denied = status === 403 || b.decision?.kind === 'DENY' || status >= 400;
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, denied);
    }
    case 'simulate_intent': {
      const { status, body } = await api('/v1/intents/simulate', {
        method: 'POST',
        body: JSON.stringify({
          op: args.op,
          agentId: args.agentId ?? 'agent-1',
          assetName: args.assetName,
          name: args.name,
          qty: args.qty,
          destination: args.destination,
          toAddress: args.toAddress,
        }),
      });
      const b = body as { decision?: { kind?: string } };
      const denied = status === 403 || b.decision?.kind === 'DENY';
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, denied || status >= 400);
    }
    case 'approve_intent': {
      const { status, body } = await api(
        `/v1/intents/${encodeURIComponent(String(args.intentId))}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ approver: args.approver ?? 'mcp-agent' }),
        },
      );
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'deny_intent': {
      const { status, body } = await api(
        `/v1/intents/${encodeURIComponent(String(args.intentId))}/deny`,
        {
          method: 'POST',
          body: JSON.stringify({ approver: args.approver ?? 'mcp-agent' }),
        },
      );
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'pending_intents': {
      const { status, body } = await api('/v1/intents/pending');
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'get_policy': {
      const agentId = typeof args.agentId === 'string' && args.agentId ? args.agentId : 'agent-1';
      const { status, body } = await api(`/v1/policies/${encodeURIComponent(agentId)}`);
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'set_policy': {
      const agentId = typeof args.agentId === 'string' && args.agentId ? args.agentId : 'agent-1';
      const policy = (args.policy ?? {}) as Record<string, unknown>;
      const { status, body } = await api(`/v1/policies/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...policy, agentId }), // force the agentId to match the route
      });
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'list_presets': {
      const { status, body } = await api('/v1/policies/presets');
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'apply_preset': {
      const agentId = typeof args.agentId === 'string' && args.agentId ? args.agentId : 'agent-1';
      const { status, body } = await api(`/v1/policies/${encodeURIComponent(agentId)}/preset`, {
        method: 'POST',
        body: JSON.stringify({ preset: args.preset, overrides: args.overrides }),
      });
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'list_assets': {
      const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : '*';
      const { status, body } = await api(`/v1/assets?pattern=${encodeURIComponent(pattern)}`);
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    case 'get_audit': {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const { status, body } = await api(`/v1/audit?limit=${encodeURIComponent(String(limit))}`);
      return textResult({ httpStatus: status, ...((body ?? {}) as object) }, status >= 400);
    }
    default:
      return textResult({ error: `unknown tool: ${name}` }, true);
  }
}

function respond(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id: string | number | null, code: number, message: string, data?: unknown): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } })}\n`,
  );
}

function handle(req: JsonRpcRequest): void {
  const { id = null, method, params } = req;

  // Notifications (no id) get no response.
  const isNotification = req.id === undefined || req.id === null;
  const ok = (result: unknown) => { if (!isNotification) respond(id, result); };
  const err = (code: number, message: string, data?: unknown) => {
    if (!isNotification) respondError(id, code, message, data);
  };

  if (req.jsonrpc !== '2.0' || typeof method !== 'string') {
    return err(-32600, 'invalid request: expected JSON-RPC 2.0 with a method');
  }

  switch (method) {
    case 'initialize': {
      const p = (params ?? {}) as { protocolVersion?: string };
      log(`client handshake (client protocol ${p.protocolVersion ?? 'unknown'})`);
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'rvn-agent-api', version: '0.13.0' },
      });
    }
    case 'notifications/initialized':
      return; // no-op acknowledgement
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (typeof p.name !== 'string') {
        return err(-32602, 'invalid params: tools/call needs { name, arguments }');
      }
      callTool(p.name, p.arguments ?? {})
        .then((result) => ok(result))
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          log(`tool ${p.name} failed: ${message}`);
          ok(textResult({ error: `tool failed: ${message}` }, true));
        });
      return;
    }
    default:
      return err(-32601, `method not found: ${method}`);
  }
}

async function main(): Promise<void> {
  log(`starting; proxying to ${API}`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as JsonRpcRequest);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log(`parse error: ${message}`);
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
        );
      }
    }
  });
  process.stdin.on('end', () => {
    log('stdin closed, exiting');
    process.exit(0);
  });
  // Keep the process alive for stdio even with no timers pending.
  process.stdin.resume();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
