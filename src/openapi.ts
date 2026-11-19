/**
 * OpenAPI 3.0.3 contract for rvn-agent-api (v0.33.0).
 *
 * Hand-maintained, served verbatim at GET /v1/openapi.json, and kept in
 * lockstep with the server by `pnpm test:openapi`: the test parses the
 * route registrations out of `src/server.ts` and asserts the spec's
 * method+path set is exactly the server's, and probes every spec
 * operation against a booted API, so a route added without a spec entry
 * (or a spec entry for a route that no longer exists) fails the build.
 *
 * The document is the contract agents should code against: every route,
 * decision shape, reason code, and error status the API can return.
 * Quantities are decimal strings in base units throughout — never floats.
 */

export const OPENAPI_VERSION = '3.0.3';

/** Every reason code a Decision can carry, in one place. */
export const REASON_CODES = [
  // ALLOW
  'WITHIN_POLICY',
  // REQUIRE_APPROVAL (hold reasons)
  'DESTINATION_NOT_ALLOWLISTED',
  'ABOVE_APPROVAL_THRESHOLD',
  'ANOMALY_SUSPECTED',
  'QUORUM_REQUIRED',
  // DENY (hard policy denies)
  'DESTINATION_BLOCKED',
  'ASSET_NAME_REJECTED',
  'NON_POSITIVE_QTY',
  'ISSUE_CAP_EXCEEDED',
  'DAILY_ISSUE_BUDGET_EXCEEDED',
  'TRANSFER_CAP_EXCEEDED',
  // DENY from the server gates (not the evaluator)
  'RATE_LIMIT_EXCEEDED',
  // Approval-path outcomes, recorded on the resolved decision
  'DENIED_BY_OWNER',
  'APPROVED',
] as const;

export const openApiDocument = {
  openapi: OPENAPI_VERSION,
  info: {
    title: 'rvn-agent-api',
    version: '0.35.0',
    description:
      'Agent-facing API for Ravencoin assets, with a policy engine in front. ' +
      'Every submit (issue, reissue, sub-asset, unique asset, transfer) is evaluated ' +
      'against the agent\'s policy and returns ALLOW (executed), REQUIRE_APPROVAL ' +
      '(held for a human approver), or DENY. All decisions are recorded on a ' +
      'hash-chained audit log. The node is a mock by default (MOCK_RVN=true); ' +
      'point it at ravend for live. Quantities are decimal strings in base units — never floats.',
    license: { name: 'AGPL-3.0', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
  },
  servers: [{ url: 'http://127.0.0.1:3001', description: 'Local API (localhost-only bind)' }],
  tags: [
    { name: 'Health', description: 'Liveness, ops metrics, and this contract.' },
    { name: 'Assets', description: 'Policy-gated asset operations and reads.' },
    { name: 'Intents', description: 'Approval flow and dry-run simulation.' },
    { name: 'Policies', description: 'Per-agent policy documents and presets.' },
    { name: 'Observability', description: 'Rate-limit and anomaly stats, audit trail and retention.' },
    { name: 'Admin', description: 'API-key issuance and revocation (operator key only).' },
    { name: 'Telegram', description: 'Approval callbacks from Telegram inline buttons.' },
  ],
  security: [{ BearerAuth: [] }],
  paths: {
    '/v1/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness check',
        description:
          'Unauthenticated. Reports node info (mock or real), the store backend, applied ' +
          'migrations, auth mode and live-key count, audit retention config and partitioning, ' +
          'approval-transport and webhook configuration.',
        security: [],
        responses: {
          '200': {
            description: 'API is up.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    },
    '/v1/openapi.json': {
      get: {
        tags: ['Health'],
        summary: 'This OpenAPI contract',
        description:
          'Unauthenticated. Returns this document verbatim — the machine-readable contract ' +
          'agents should code against. `pnpm test:openapi` asserts it never drifts from the server.',
        security: [],
        responses: {
          '200': {
            description: 'The OpenAPI 3.0.3 document.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/docs': {
      get: {
        tags: ['Health'],
        summary: 'Human-readable API docs',
        description:
          'Unauthenticated. A single self-contained HTML page generated from this contract on every ' +
          'request — every route grouped by tag with its parameters, request body and responses, plus ' +
          'the decision model and the full reason-code list. No external assets, no JavaScript.',
        security: [],
        responses: {
          '200': {
            description: 'The docs page as HTML.',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/v1/metrics': {
      get: {
        tags: ['Health'],
        summary: 'Ops metrics',
        description:
          'Read-only. Decision counts by kind and reason code, rate-limit 429s by agent and kind, ' +
          'webhook delivery successes/failures by endpoint, approval hold age (oldest pending), and ' +
          'the store backend. Aggregated from the retained audit chain at request time; counts cover ' +
          'the retained chain only (archived slices live in the archive files). Polling writes nothing.',
        responses: {
          '200': {
            description: 'Current metrics.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Metrics' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/wallets': {
      post: {
        tags: ['Assets'],
        summary: 'Provision an agent wallet address',
        responses: {
          '200': {
            description: 'A fresh address from the node.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address'],
                  properties: { address: { type: 'string', description: 'New Ravencoin address.' } },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/assets/issue': {
      post: {
        tags: ['Assets'],
        summary: 'Issue a new asset',
        description:
          'Policy-gated like every submit. ALLOW executes immediately (200 + txid); ' +
          'REQUIRE_APPROVAL holds for a human (202); DENY returns 403; an exhausted ' +
          'rate-limit bucket returns 429 with a DENY decision; a node failure returns 502.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'qty', 'toAddress'],
                properties: {
                  name: { type: 'string', description: 'Asset name, uppercased by the server.', example: 'DEMOCOIN' },
                  qty: { type: 'string', description: 'Quantity in base units (decimal string).' },
                  toAddress: { type: 'string', description: 'Destination address.' },
                  agentId: { type: 'string', description: 'Agent identity. Defaults to the key\'s agent (auth on) or agent-1 (auth off).' },
                  units: { type: 'integer', description: 'Decimal places (default 0).' },
                  reissuable: { type: 'boolean', description: 'Whether the asset stays reissuable (default true).' },
                  ipfsHash: { type: 'string', description: 'Optional IPFS/Txid hash attached to the asset.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'ALLOW — executed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '202': { description: 'REQUIRE_APPROVAL — held for a human approver.', content: { 'application/json': { schema: { $ref: '#/components/schemas/HeldResult' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'DENY, agent mismatch, or scope insufficient.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '429': { description: 'Rate limit exceeded (DENY decision with reason RATE_LIMIT_EXCEEDED).', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '502': { $ref: '#/components/responses/NodeFailed' },
        },
      },
    },
    '/v1/assets/reissue': {
      post: {
        tags: ['Assets'],
        summary: 'Reissue more supply of an existing reissuable asset',
        description:
          'Policy-gated exactly like an issue (per-op cap, 24h issue budget, approval threshold, ' +
          'destination allowlist, asset-name pattern). Optional extras: `reissuable` flips the ' +
          'reissuable flag, `newUnits` (0–8) replaces the decimal places, `newIpfsHash` replaces the ' +
          'IPFS/Txid hash — ravend\'s params are positional, so `newUnits` is required when ' +
          '`newIpfsHash` is set. Unknown asset: 502.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'qty', 'toAddress'],
                properties: {
                  name: { type: 'string', description: 'Existing reissuable asset name.' },
                  qty: { type: 'string', description: 'Additional quantity in base units (decimal string).' },
                  toAddress: { type: 'string', description: 'Destination address.' },
                  agentId: { type: 'string', description: 'Agent identity (default: the key\'s agent, or agent-1).' },
                  reissuable: { type: 'boolean', description: 'Flip the reissuable flag.' },
                  newUnits: { type: 'integer', minimum: 0, maximum: 8, description: 'Replace the decimal places (0–8). Required when newIpfsHash is set.' },
                  newIpfsHash: { type: 'string', description: 'Replace the IPFS/Txid hash.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'ALLOW — executed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '202': { description: 'REQUIRE_APPROVAL — held for a human approver.', content: { 'application/json': { schema: { $ref: '#/components/schemas/HeldResult' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'DENY, agent mismatch, or scope insufficient.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '429': { description: 'Rate limit exceeded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '502': { $ref: '#/components/responses/NodeFailed' },
        },
      },
    },
    '/v1/assets/issue-subasset': {
      post: {
        tags: ['Assets'],
        summary: 'Issue a sub-asset under an existing parent asset',
        description:
          'Policy-gated like an issue, except the asset-name pattern is applied to every ' +
          'slash-separated segment. The name must contain `/` (PARENT/SUB; nested PARENT/CHILD/GRAND ' +
          'works when the immediate parent exists). Unknown parent: 502.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'qty', 'toAddress'],
                properties: {
                  name: { type: 'string', description: 'Sub-asset name, e.g. MYCOIN/REWARDS (parent must exist).' },
                  qty: { type: 'string', description: 'Quantity in base units (decimal string).' },
                  toAddress: { type: 'string', description: 'Destination address.' },
                  agentId: { type: 'string', description: 'Agent identity (default: the key\'s agent, or agent-1).' },
                  units: { type: 'integer', description: 'Decimal places (default 0).' },
                  reissuable: { type: 'boolean', description: 'Whether the sub-asset stays reissuable (default true).' },
                  ipfsHash: { type: 'string', description: 'Optional IPFS/Txid hash attached to the sub-asset.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'ALLOW — executed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '202': { description: 'REQUIRE_APPROVAL — held for a human approver.', content: { 'application/json': { schema: { $ref: '#/components/schemas/HeldResult' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'DENY, agent mismatch, or scope insufficient.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '429': { description: 'Rate limit exceeded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '502': { $ref: '#/components/responses/NodeFailed' },
        },
      },
    },
    '/v1/assets/issue-unique': {
      post: {
        tags: ['Assets'],
        summary: 'Issue a unique asset (Ravencoin NFT)',
        description:
          'Policy-gated like an issue, except the name is ROOT#TAG, the root must exist, and the ' +
          'asset is a singleton: qty is fixed at 1 (omit it, or pass "1" — anything else is a 400), ' +
          'units are 0, and the asset is never reissuable. The root may itself be a sub-asset ' +
          '(ART/DAVINCI#MONALISA). Unknown root: 502.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'toAddress'],
                properties: {
                  name: { type: 'string', description: 'Unique asset name, ROOT#TAG (root must exist).' },
                  qty: { type: 'string', description: 'Must be "1" when given; defaults to "1".', enum: ['1'] },
                  toAddress: { type: 'string', description: 'Destination address.' },
                  agentId: { type: 'string', description: 'Agent identity (default: the key\'s agent, or agent-1).' },
                  ipfsHash: { type: 'string', description: 'Optional IPFS/Txid hash attached to the asset.' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'ALLOW — executed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '202': { description: 'REQUIRE_APPROVAL — held for a human approver.', content: { 'application/json': { schema: { $ref: '#/components/schemas/HeldResult' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'DENY, agent mismatch, or scope insufficient.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '429': { description: 'Rate limit exceeded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '502': { $ref: '#/components/responses/NodeFailed' },
        },
      },
    },
    '/v1/assets/transfer': {
      post: {
        tags: ['Assets'],
        summary: 'Transfer an asset',
        description:
          'Policy-gated: per-op transfer cap, approval threshold, destination allowlist, and the ' +
          'transfer rate-limit bucket. Same status codes as issue.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['assetName', 'qty', 'destination'],
                properties: {
                  assetName: { type: 'string', description: 'Asset to transfer.' },
                  qty: { type: 'string', description: 'Quantity in base units (decimal string).' },
                  destination: { type: 'string', description: 'Destination address.' },
                  agentId: { type: 'string', description: 'Agent identity (default: the key\'s agent, or agent-1).' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'ALLOW — executed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '202': { description: 'REQUIRE_APPROVAL — held for a human approver.', content: { 'application/json': { schema: { $ref: '#/components/schemas/HeldResult' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'DENY, agent mismatch, or scope insufficient.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '429': { description: 'Rate limit exceeded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } },
          '502': { $ref: '#/components/responses/NodeFailed' },
        },
      },
    },
    '/v1/assets': {
      get: {
        tags: ['Assets'],
        summary: 'List assets known to the node',
        parameters: [
          {
            name: 'pattern',
            in: 'query',
            description: 'Glob pattern, e.g. DEMO* (default *).',
            schema: { type: 'string', default: '*' },
          },
        ],
        responses: {
          '200': {
            description: 'Asset names.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['assets'],
                  properties: { assets: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/assets/{name}': {
      get: {
        tags: ['Assets'],
        summary: 'Asset details',
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Asset data from the node.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AssetData' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'Unknown asset.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/v1/intents/simulate': {
      post: {
        tags: ['Intents'],
        summary: 'Dry-run an intent through the policy engine',
        description:
          'Returns the decision the policy WOULD make — ALLOW / REQUIRE_APPROVAL / DENY with reason ' +
          'codes — without persisting the intent, recording issue spend, touching the audit chain, ' +
          'notifying approvers, executing anything, or spending a rate-limit token. The returned ' +
          'decision id is `sim-<uuid>` and refers to nothing stored: approving it 404s. Field ' +
          'aliases `name` / `toAddress` are accepted; for op `unique` the qty is normalized to "1".',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['op', 'qty', 'destination'],
                properties: {
                  op: { type: 'string', enum: ['issue', 'transfer', 'reissue', 'subasset', 'unique'], description: 'Operation to simulate.' },
                  assetName: { type: 'string', description: 'Asset name (alias: name).' },
                  name: { type: 'string', description: 'Alias for assetName.' },
                  qty: { type: 'string', description: 'Quantity in base units (decimal string). Defaults to "1" for op unique.' },
                  destination: { type: 'string', description: 'Destination address (alias: toAddress).' },
                  toAddress: { type: 'string', description: 'Alias for destination.' },
                  agentId: { type: 'string', description: 'Agent identity (default: the key\'s agent, or agent-1).' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The simulated decision.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['simulated', 'decision', 'note'],
                  properties: {
                    simulated: { type: 'boolean', const: true },
                    decision: { $ref: '#/components/schemas/Decision' },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/intents/{id}/approve': {
      post: {
        tags: ['Intents'],
        summary: 'Approve a held intent',
        description:
          'Executes the held intent (re-evaluated against the current policy first — a re-evaluation ' +
          'DENY returns 403 and ends the hold). A quorum hold returns 202 with `approvalsReceived` / ' +
          '`approvalsRequired` until N distinct approvers have approved, then executes on the Nth; ' +
          'the same approver approving twice counts once (202, `alreadyCounted: true`); a non-roster ' +
          'approver gets 403. A deny by any single approver ends the hold outright.',
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'Intent id (not a sim- id).', schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  approver: { type: 'string', description: 'Approver identity label (default "human"). Telegram taps use "telegram:<name>".' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Executed (or quorum met and executed).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApprovalResult' } } } },
          '202': { description: 'Quorum approval recorded; more approvers needed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/QuorumProgress' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Denied on re-evaluation, non-roster approver, agent mismatch, or scope insufficient.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Unknown intent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Intent is not pending approval (already ALLOW/DENY).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '410': { description: 'Decision expired — submit a new intent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '502': { $ref: '#/components/responses/NodeFailed' },
        },
      },
    },
    '/v1/intents/{id}/deny': {
      post: {
        tags: ['Intents'],
        summary: 'Deny a held intent',
        description:
          'Any single approver ends the hold outright — roster or not, quorum or not. The decision ' +
          'becomes DENY with DENIED_BY_OWNER prepended to its reason codes.',
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'Intent id (not a sim- id).', schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  approver: { type: 'string', description: 'Approver identity label (default "human").' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Denied.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['intent', 'denied', 'approver'],
                  properties: {
                    intent: { $ref: '#/components/schemas/RvnIntent' },
                    denied: { type: 'boolean', const: true },
                    approver: { type: 'string' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { description: 'Unknown intent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Intent is not pending approval.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '410': { description: 'Decision expired — submit a new intent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/v1/intents/pending': {
      get: {
        tags: ['Intents'],
        summary: 'Intents awaiting approval',
        responses: {
          '200': {
            description: 'Pending intents with their decisions.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['pending'],
                  properties: {
                    pending: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['intent', 'decision'],
                        properties: {
                          intent: { $ref: '#/components/schemas/RvnIntent' },
                          decision: { $ref: '#/components/schemas/Decision' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/telegram/webhook': {
      post: {
        tags: ['Telegram'],
        summary: 'Telegram callback webhook',
        description:
          'Receives callback queries when the owner taps Approve/Deny on a hold notification. ' +
          'Unauthenticated by API key — when TELEGRAM_WEBHOOK_SECRET is set, the ' +
          '`X-Telegram-Bot-Api-Secret-Token` header must match (403 otherwise). Always answers 200 ' +
          'so Telegram never retries; the outcome is surfaced through answerCallbackQuery and by ' +
          'editing the hold message in place.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Telegram Bot API update carrying a callback_query.',
                properties: {
                  callback_query: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      data: { type: 'string', description: 'Encoded approve/deny action + intent id.' },
                      from: { type: 'object', properties: { first_name: { type: 'string' }, username: { type: 'string' } } },
                      message: { type: 'object', properties: { message_id: { type: 'integer' }, chat: { type: 'object', properties: { id: { type: ['integer', 'string'] } } } } },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Update accepted (or ignored when it is not a callback query).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok'],
                  properties: {
                    ok: { type: 'boolean', const: true },
                    ignored: { type: 'string', description: 'Present when the update carried no callback query.' },
                  },
                },
              },
            },
          },
          '403': { description: 'Bad webhook secret.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/v1/ratelimit/{agentId}': {
      get: {
        tags: ['Observability'],
        summary: 'Rate-limit stats for an agent',
        description:
          'Read-only: the snapshot never spends a token and never advances the bucket\'s clock, so ' +
          'polling it can neither throttle nor un-throttle the agent. Agents without a rate-limit ' +
          'pair report `{ limited: false }`; per-kind buckets appear under `kinds`.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Bucket snapshot (or unlimited).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RateLimitStats' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/anomaly/{agentId}': {
      get: {
        tags: ['Observability'],
        summary: 'Anomaly stats for an agent',
        description:
          'Read-only: how many anomaly holds the gate raised over a recent window, split by signal ' +
          '(QTY_OUTLIER / FIRST_SEEN_DESTINATION_BURST), holds still pending, and the thresholds ' +
          'currently in force. A hold counts when its stored decision carries ANOMALY_SUSPECTED. ' +
          'The read writes nothing.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'windowHours',
            in: 'query',
            description: 'Window in hours (default 24, clamped 1..168).',
            schema: { type: 'integer', default: 24, minimum: 1, maximum: 168 },
          },
        ],
        responses: {
          '200': {
            description: 'Anomaly hold stats.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AnomalyStats' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/audit': {
      get: {
        tags: ['Observability'],
        summary: 'Hash-chained audit trail',
        description:
          'The tail of the retained audit chain plus whether it verifies. Archived slices are not ' +
          'included — they live in the archive files (see POST /v1/audit/archive).',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Max entries to return (default 50).',
            schema: { type: 'integer', default: 50 },
          },
        ],
        responses: {
          '200': {
            description: 'Chain validity + entries, newest last.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['chainValid', 'entries'],
                  properties: {
                    chainValid: { type: 'boolean' },
                    entries: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/audit/archive': {
      post: {
        tags: ['Observability'],
        summary: 'Archive and prune the audit chain',
        description:
          'Exports every entry older than the cutoff to a JSON archive file with a ' +
          'chain-verification proof, then prunes the archived entries from the live chain. The ' +
          'newest entry is always kept as the chain anchor, so the retained chain stays verifiable — ' +
          'its oldest entry links to the archive head hash (verifyContinuity). At most 10,000 entries ' +
          'per call; `moreMayRemain` says to call again. A broken chain refuses with 500 instead of ' +
          'archiving history away. The proof is recorded in-chain as an AUDIT_ARCHIVED entry.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  beforeMs: { type: 'integer', description: 'Epoch-ms cutoff; omitted means "older than the retention policy" (RVN_AUDIT_RETENTION_DAYS, default 90 days).' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Archive written and entries pruned (or nothing to archive).',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ArchiveResult' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { description: 'Broken chain (refused) or archive file write failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/v1/policies/presets': {
      get: {
        tags: ['Policies'],
        summary: 'List the policy presets',
        description: 'The gallery: conservative (tight caps, low thresholds, empty allowlist), balanced (the Phase-0 default), and permissive (high caps/thresholds, wildcard allowlist, 1h TTL).',
        responses: {
          '200': {
            description: 'Presets keyed by id.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['presets'],
                  properties: {
                    presets: { type: 'object', additionalProperties: { $ref: '#/components/schemas/RvnPolicy' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/policies/{agentId}': {
      get: {
        tags: ['Policies'],
        summary: 'Fetch an agent\'s policy',
        description:
          'Resolves the agent\'s stored policy, falling back to the `*` policy, then the built-in ' +
          'default. A non-operator key may only read its own agent.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'The effective policy.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RvnPolicy' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      put: {
        tags: ['Policies'],
        summary: 'Replace an agent\'s policy',
        description:
          'Wholesale replace (all required fields must be present; `version` must be 1 and `agentId` ' +
          'must match the path). Rate-limit fields must be set as a pair or neither; quorum fields ' +
          'follow the all-or-nothing rule; anomaly fields must be positive integers. A bad field is ' +
          'a 400 and nothing is stored. The superseded policy is kept in history ' +
          '(GET /v1/policies/:agentId/history) and can be restored with a rollback. ' +
          'Audited as POLICY_REPLACED.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RvnPolicy' } } },
        },
        responses: {
          '200': {
            description: 'Stored policy.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['policy'],
                  properties: { policy: { $ref: '#/components/schemas/RvnPolicy' } },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/policies/{agentId}/preset': {
      post: {
        tags: ['Policies'],
        summary: 'Apply a preset to an agent',
        description:
          'Same replace semantics as PUT, with optional per-agent `overrides` (any overridable policy ' +
          'field — caps, budgets, thresholds, destination lists, name pattern, TTL, rate limits, ' +
          'anomaly thresholds, quorum fields, roster). Unknown preset / field / malformed value is a ' +
          '400 and nothing is stored. Audited as POLICY_REPLACED naming the preset.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['preset'],
                properties: {
                  preset: { type: 'string', enum: ['conservative', 'balanced', 'permissive'] },
                  overrides: { type: 'object', description: 'Per-agent policy field overrides.', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Applied preset + resulting policy.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['preset', 'policy'],
                  properties: {
                    preset: { type: 'string' },
                    policy: { $ref: '#/components/schemas/RvnPolicy' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/policies/{agentId}/history': {
      get: {
        tags: ['Policies'],
        summary: 'List an agent\'s superseded policy versions',
        description:
          'Superseded policy versions for an agent, newest first — the policy that was live, ' +
          'snapshotted when it was replaced. The live policy is never in the list. `limit` caps ' +
          'the rows returned (default = the configured history limit, clamped 1..100). A ' +
          'non-operator key may only read its own agent.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: {
          '200': {
            description: 'History versions, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['agentId', 'limit', 'versions'],
                  properties: {
                    agentId: { type: 'string' },
                    limit: { type: 'integer' },
                    versions: { type: 'array', items: { $ref: '#/components/schemas/PolicyVersion' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/policies/{agentId}/rollback': {
      post: {
        tags: ['Policies'],
        summary: 'Roll back an agent\'s policy to a history version',
        description:
          'Restores the named history version as the live policy. The policy it replaces is ' +
          'archived as a new version, so a rollback is itself undoable. Audited as ' +
          'POLICY_REPLACED naming the source version. Unknown versionId is a 404 and nothing ' +
          'changes.',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['versionId'],
                properties: {
                  versionId: { type: 'string', description: 'Version id from GET /v1/policies/:agentId/history.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Restored policy.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['policy', 'restoredFrom'],
                  properties: {
                    policy: { $ref: '#/components/schemas/RvnPolicy' },
                    restoredFrom: { type: 'string', description: 'The version id that was restored.' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/admin/api-keys': {
      post: {
        tags: ['Admin'],
        summary: 'Issue an API key for an agent',
        description:
          'Operator key only. Returns the raw key exactly once — it is never stored and can never be ' +
          'listed again; only its SHA-256 hash is kept. Optional `scopes` (`read` / `write`; omitted ' +
          'means full access). An invalid scope list is a 400, so a half-valid request can never ' +
          'silently mint a full-access key. Audited as API_KEY_ISSUED.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['agentId'],
                properties: {
                  agentId: { type: 'string', description: 'Agent the key is issued for.' },
                  scopes: { type: 'array', description: 'Optional scope list; omitted means full access.', items: { type: 'string', enum: ['read', 'write'] } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Issued key (raw, shown once) + public record.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['key', 'record'],
                  properties: {
                    key: { type: 'string', description: 'Raw key (rvn_ + 32 hex chars) — shown once, never stored.' },
                    record: { $ref: '#/components/schemas/ApiKeyRecord' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      get: {
        tags: ['Admin'],
        summary: 'List issued API keys',
        description:
          'Operator key only. Public view only — id, agent, prefix, scopes, timestamps, revocation — ' +
          'never a hash, never a raw key. Optional `?agentId=` filter.',
        parameters: [
          {
            name: 'agentId',
            in: 'query',
            description: 'Filter to one agent\'s keys.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Issued keys (public view).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keys'],
                  properties: { keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyRecord' } } },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/admin/api-keys/{id}/revoke': {
      post: {
        tags: ['Admin'],
        summary: 'Revoke an API key immediately',
        description:
          'Operator key only. Revocation sets the timestamp instead of deleting the row, so a revoked ' +
          'key stays auditable and its hash can never be re-issued as a live key by accident. The next ' +
          'request with that key gets 401. Audited as API_KEY_REVOKED. A second revoke keeps the ' +
          'original time.',
        parameters: [
          { name: 'id', in: 'path', required: true, description: 'Key record id.', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Revoked record (public view).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['record'],
                  properties: { record: { $ref: '#/components/schemas/ApiKeyRecord' } },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { description: 'Unknown API key.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key (rvn_ + 32 hex chars) or the operator key',
        description:
          'Per-agent API key, issued through POST /v1/admin/api-keys and stored hashed. ' +
          'With auth off (the default) no key is needed. /v1/health and /v1/openapi.json never ' +
          'require a key; /v1/telegram/webhook uses its own secret instead.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string', description: 'Human-readable error message.' } },
      },
      Decision: {
        type: 'object',
        required: ['intentId', 'agentId', 'kind', 'reasonCodes', 'decidedAtMs', 'expiresAtMs'],
        properties: {
          intentId: { type: 'string', description: 'Intent id, or sim-<uuid> for a simulation (refers to nothing stored).' },
          agentId: { type: 'string' },
          kind: { type: 'string', enum: ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] },
          reasonCodes: {
            type: 'array',
            items: { type: 'string', enum: [...REASON_CODES] },
            description:
              'WITHIN_POLICY (ALLOW); DESTINATION_NOT_ALLOWLISTED / ABOVE_APPROVAL_THRESHOLD / ' +
              'ANOMALY_SUSPECTED / QUORUM_REQUIRED (holds); DESTINATION_BLOCKED / ASSET_NAME_REJECTED / ' +
              'NON_POSITIVE_QTY / ISSUE_CAP_EXCEEDED / DAILY_ISSUE_BUDGET_EXCEEDED / TRANSFER_CAP_EXCEEDED / ' +
              'RATE_LIMIT_EXCEEDED (denies); DENIED_BY_OWNER / APPROVED (approval-path outcomes).',
          },
          decidedAtMs: { type: 'integer', description: 'Epoch ms when the decision was made.' },
          expiresAtMs: { type: 'integer', description: 'Epoch ms when the decision expires (decisionTtlSeconds after it was made).' },
          quorumRequired: { type: 'integer', description: 'Distinct approvers required before this held intent may execute (absent = one approver suffices).' },
          approvals: { type: 'array', items: { type: 'string' }, description: 'Approver identities recorded so far for a quorum hold (distinct — the same approver twice counts once).' },
          quorumApprovers: { type: 'array', items: { type: 'string' }, description: 'Roster (M) snapshotted at hold time: only these identities count toward this hold\'s quorum.' },
        },
      },
      RvnIntent: {
        type: 'object',
        required: ['id', 'agentId', 'kind', 'assetName', 'qtyBaseUnits', 'destination', 'requestedAtMs'],
        properties: {
          id: { type: 'string' },
          agentId: { type: 'string' },
          kind: { type: 'string', enum: ['issue_asset', 'transfer_asset', 'reissue_asset', 'issue_subasset', 'issue_unique'] },
          assetName: { type: 'string', description: 'Asset name, uppercased (e.g. MYCOIN, MYCOIN/REWARDS, ROOT#TAG).' },
          qtyBaseUnits: { type: 'string', description: 'Quantity in base units (decimal string). Unique assets are always "1".' },
          destination: { type: 'string', description: 'Destination address.' },
          requestedAtMs: { type: 'integer', description: 'Epoch ms when the intent was submitted.' },
          execParams: {
            type: 'object',
            description: 'Extra node params captured at submit time and replayed at approval-time execution.',
            properties: {
              units: { type: 'integer', description: 'issue/sub-asset: decimal places (default 0).' },
              reissuable: { type: 'boolean', description: 'issue/sub-asset: stays reissuable (default true); reissue: flip the flag.' },
              ipfsHash: { type: 'string', description: 'issue/sub-asset/unique: IPFS/Txid hash.' },
              newUnits: { type: 'integer', minimum: 0, maximum: 8, description: 'reissue: replace the decimal places.' },
              newIpfsHash: { type: 'string', description: 'reissue: replace the IPFS/Txid hash.' },
            },
          },
        },
      },
      RvnPolicy: {
        type: 'object',
        required: [
          'version', 'agentId', 'maxIssueQtyBaseUnits', 'approvalAboveIssueQtyBaseUnits',
          'dailyIssueBudgetBaseUnits', 'maxTransferQtyBaseUnits', 'approvalAboveTransferQtyBaseUnits',
          'allowedDestinations', 'blockedDestinations', 'assetNamePattern', 'decisionTtlSeconds',
        ],
        properties: {
          version: { type: 'integer', const: 1 },
          agentId: { type: 'string', description: 'Specific agent, or "*" for the default policy.' },
          maxIssueQtyBaseUnits: { type: 'string', description: 'Per-operation issue ceiling. Above -> DENY.' },
          approvalAboveIssueQtyBaseUnits: { type: 'string', description: 'Issue qty above this -> REQUIRE_APPROVAL.' },
          dailyIssueBudgetBaseUnits: { type: 'string', description: 'Rolling 24h issue budget per agent. Above -> DENY.' },
          maxTransferQtyBaseUnits: { type: 'string', description: 'Per-operation transfer ceiling. Above -> DENY.' },
          approvalAboveTransferQtyBaseUnits: { type: 'string', description: 'Transfer qty above this -> REQUIRE_APPROVAL.' },
          allowedDestinations: { type: 'array', items: { type: 'string' }, description: 'RVN addresses, or ["*"]. Unknown destination -> REQUIRE_APPROVAL.' },
          blockedDestinations: { type: 'array', items: { type: 'string' }, description: 'Always DENY, no exceptions.' },
          assetNamePattern: { type: 'string', description: 'Regex source asset names must match, e.g. ^[A-Z0-9._]{3,30}$.' },
          decisionTtlSeconds: { type: 'integer', description: 'How long an ALLOW / REQUIRE_APPROVAL decision stays valid.' },
          rateLimitMaxOps: { type: 'integer', description: 'Optional token-bucket capacity (operations); set together with rateLimitWindowSeconds or neither for unlimited.' },
          rateLimitWindowSeconds: { type: 'integer', description: 'Optional window in seconds over which a full rate-limit bucket refills.' },
          rateLimitKindLimits: {
            type: 'object',
            description: 'Optional per-kind token buckets, layered on top of the agent-wide bucket.',
            additionalProperties: {
              type: 'object',
              required: ['maxOps', 'windowSeconds'],
              properties: {
                maxOps: { type: 'integer' },
                windowSeconds: { type: 'integer' },
              },
            },
          },
          anomalyQtyMultiple: { type: 'integer', description: 'Optional qty-outlier multiple (default 10).' },
          anomalyMinHistory: { type: 'integer', description: 'Optional minimum same-kind samples before a qty outlier can fire (default 3).' },
          anomalyBurstWindowSeconds: { type: 'integer', description: 'Optional burst window in seconds (default 3600).' },
          anomalyBurstMinCount: { type: 'integer', description: 'Optional minimum intents in the burst window before a first-seen destination flags (default 3).' },
          quorumApprovals: { type: 'integer', description: 'Optional distinct approvers required for a quorum hold (must be >= 2).' },
          quorumAboveIssueQtyBaseUnits: { type: 'string', description: 'Optional supply-creating qty above this needs quorum.' },
          quorumAboveTransferQtyBaseUnits: { type: 'string', description: 'Optional transfer qty above this needs quorum.' },
          quorumApprovers: { type: 'array', items: { type: 'string' }, description: 'Optional approver roster (M): only these identities count toward quorum; the count must not exceed the roster size.' },
        },
      },
      PolicyVersion: {
        type: 'object',
        description: 'A superseded policy version: the policy that was live for an agent, snapshotted when it was replaced. The live policy is never a version.',
        required: ['versionId', 'agentId', 'policy', 'replacedAtMs', 'replacedBy'],
        properties: {
          versionId: { type: 'string', description: 'Opaque id to pass to POST /v1/policies/:agentId/rollback.' },
          agentId: { type: 'string' },
          policy: { $ref: '#/components/schemas/RvnPolicy' },
          replacedAtMs: { type: 'integer', description: 'Epoch ms when this policy stopped being live.' },
          replacedBy: { type: 'string', enum: ['put', 'preset', 'rollback'], description: 'How it was replaced.' },
          preset: { type: 'string', description: 'Present when the version came from a preset apply: the preset that produced it.' },
          sourceVersionId: { type: 'string', description: 'Present when the version was replaced by a rollback: the version that was restored.' },
        },
      },
      SubmitResult: {
        type: 'object',
        required: ['intent', 'decision'],
        properties: {
          intent: { $ref: '#/components/schemas/RvnIntent' },
          decision: { $ref: '#/components/schemas/Decision' },
          txid: { type: 'string', description: 'Present when ALLOW executed (mock node: a mock txid).' },
          mock: { type: 'boolean', description: 'True when the mock node executed (MOCK_RVN=true).' },
          error: { type: 'string', description: 'Present on a 502 node failure.' },
        },
      },
      HeldResult: {
        type: 'object',
        required: ['intent', 'decision', 'message'],
        properties: {
          intent: { $ref: '#/components/schemas/RvnIntent' },
          decision: { $ref: '#/components/schemas/Decision' },
          message: { type: 'string', description: 'Held for human approval — POST /v1/intents/:id/approve.' },
        },
      },
      ApprovalResult: {
        type: 'object',
        required: ['intent', 'txid'],
        properties: {
          intent: { $ref: '#/components/schemas/RvnIntent' },
          txid: { type: 'string' },
          mock: { type: 'boolean' },
          approver: { type: 'string' },
          approvalsReceived: { type: 'integer', description: 'Present on a quorum hold: the count that met quorum.' },
          approvalsRequired: { type: 'integer' },
          approversTotal: { type: 'integer', description: 'Present when the hold carried a roster: the roster size (M).' },
        },
      },
      QuorumProgress: {
        type: 'object',
        required: ['intent', 'decision', 'approver', 'approvalsReceived', 'approvalsRequired'],
        properties: {
          intent: { $ref: '#/components/schemas/RvnIntent' },
          decision: { $ref: '#/components/schemas/Decision' },
          approver: { type: 'string' },
          alreadyCounted: { type: 'boolean', description: 'True when this approver already counted toward the quorum.' },
          approvalsReceived: { type: 'integer' },
          approvalsRequired: { type: 'integer' },
          approversTotal: { type: 'integer', description: 'Roster size (M), when the hold carries one.' },
          message: { type: 'string' },
        },
      },
      AssetData: {
        type: 'object',
        description: 'Asset data as returned by the node (getassetdata). Shape depends on the node; the mock returns name, amount, units, reissuable, has_ipfs, ipfs_hash, and the issuing addresses.',
        additionalProperties: true,
        properties: {
          name: { type: 'string' },
          amount: { type: 'number' },
          units: { type: 'integer' },
          reissuable: { type: 'boolean' },
          has_ipfs: { type: 'boolean' },
          ipfs_hash: { type: 'string' },
        },
      },
      AuditEntry: {
        type: 'object',
        required: ['seq', 'prevHash', 'hash', 'atMs', 'kind', 'intentId', 'agentId', 'detail'],
        properties: {
          seq: { type: 'integer', description: 'Monotonic sequence number in the hash chain.' },
          prevHash: { type: 'string', description: 'Hash of the previous entry (GENESIS for the first).' },
          hash: { type: 'string', description: 'Hash of this entry, chaining prevHash + content.' },
          atMs: { type: 'integer', description: 'Epoch ms when the entry was appended.' },
          kind: { type: 'string', description: 'Entry kind, e.g. DECISION, APPROVAL, DENIAL, EXECUTION, AUTH_FAILED, API_KEY_ISSUED, AUDIT_ARCHIVED, WEBHOOK_DELIVERY.' },
          intentId: { type: 'string' },
          agentId: { type: 'string' },
          detail: { type: 'object', additionalProperties: true },
        },
      },
      ApiKeyRecord: {
        type: 'object',
        description: 'Public view of an issued API key — never a hash, never a raw key.',
        required: ['id', 'agentId', 'keyPrefix', 'createdAtMs'],
        properties: {
          id: { type: 'string' },
          agentId: { type: 'string' },
          keyPrefix: { type: 'string', description: 'First 8 chars after the rvn_ prefix, for identification in logs.' },
          scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] }, description: 'Scope list; absent means full access (keys issued before v0.31.0).' },
          createdAtMs: { type: 'integer' },
          revokedAtMs: { type: 'integer', description: 'Present once revoked; revocation is immediate.' },
        },
      },
      Health: {
        type: 'object',
        required: ['ok', 'mock', 'store'],
        properties: {
          ok: { type: 'boolean', const: true },
          mock: { type: 'boolean', description: 'True when the mock node is in use (MOCK_RVN=true).' },
          store: { type: 'string', enum: ['memory', 'postgres'] },
          migrations: { type: 'array', items: { type: 'string' }, description: 'Applied migration versions ([] on the memory store).' },
          auth: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              operatorKeyConfigured: { type: 'boolean' },
              keys: { type: 'integer', description: 'Live (unrevoked) issued keys; omitted when the store read fails.' },
            },
          },
          audit: {
            type: 'object',
            properties: {
              retentionDays: { type: 'integer' },
              archiveDir: { type: 'string' },
              partitioned: { type: 'boolean', description: 'True once migration 0003 (monthly partitioning) has applied.' },
            },
          },
          approvals: {
            type: 'object',
            properties: {
              telegramConfigured: { type: 'boolean' },
              telegramWebhookSecretConfigured: { type: 'boolean' },
              perAgentChatRoutes: { type: 'integer' },
            },
          },
          webhooks: {
            type: 'object',
            properties: {
              configured: { type: 'boolean' },
              endpoints: { type: 'integer' },
              retry: { type: 'object', additionalProperties: true },
            },
          },
        },
        additionalProperties: true,
      },
      Metrics: {
        type: 'object',
        description:
          'Decision counts by kind and reason code, rate-limit 429s by agent and kind, webhook ' +
          'deliveries by endpoint, approval hold age, and the store backend. Counts cover the retained ' +
          'audit chain only.',
        properties: {
          decisions: { type: 'object', additionalProperties: true },
          rateLimit429s: { type: 'object', additionalProperties: true },
          webhooks: { type: 'object', additionalProperties: true },
          approvals: { type: 'object', additionalProperties: true },
          audit: { type: 'object', additionalProperties: true },
          store: { type: 'string' },
          uptimeSeconds: { type: 'number' },
          generatedAtMs: { type: 'integer' },
        },
        additionalProperties: true,
      },
      RateLimitStats: {
        type: 'object',
        required: ['agentId', 'limited', 'kinds'],
        properties: {
          agentId: { type: 'string' },
          limited: { type: 'boolean', description: 'False when the agent has no rate-limit pair and no per-kind limits.' },
          tokens: { type: 'integer', description: 'Whole tokens currently in the agent-wide bucket.' },
          maxTokens: { type: 'integer' },
          refillRatePerSecond: { type: 'number' },
          secondsUntilNextToken: { type: 'number' },
          secondsUntilFull: { type: 'number' },
          wouldAllow: { type: 'boolean' },
          kinds: {
            type: 'object',
            description: 'Per-kind bucket snapshots, keyed by intent kind, for every kind the policy limits.',
            additionalProperties: { $ref: '#/components/schemas/RateLimitBucket' },
          },
        },
      },
      RateLimitBucket: {
        type: 'object',
        properties: {
          tokens: { type: 'integer' },
          maxTokens: { type: 'integer' },
          refillRatePerSecond: { type: 'number' },
          secondsUntilNextToken: { type: 'number' },
          secondsUntilFull: { type: 'number' },
          wouldAllow: { type: 'boolean' },
        },
      },
      AnomalyStats: {
        type: 'object',
        required: ['agentId', 'windowHours', 'intentsInWindow', 'anomalyHolds', 'anomalyHoldsPending', 'bySignal', 'thresholds'],
        properties: {
          agentId: { type: 'string' },
          windowHours: { type: 'integer' },
          intentsInWindow: { type: 'integer' },
          anomalyHolds: { type: 'integer', description: 'Holds raised in the window (stored decisions carrying ANOMALY_SUSPECTED).' },
          anomalyHoldsPending: { type: 'integer', description: 'Of those, still awaiting approval.' },
          bySignal: {
            type: 'object',
            properties: {
              QTY_OUTLIER: { type: 'integer' },
              FIRST_SEEN_DESTINATION_BURST: { type: 'integer' },
            },
          },
          thresholds: {
            type: 'object',
            properties: {
              qtyMultiple: { type: 'integer' },
              minHistory: { type: 'integer' },
              burstWindowSeconds: { type: 'integer' },
              burstMinCount: { type: 'integer' },
            },
          },
        },
      },
      ArchiveResult: {
        type: 'object',
        required: ['archived', 'entries', 'cutoffMs'],
        properties: {
          archived: { type: 'boolean' },
          entries: { type: 'integer', description: 'Entries archived (and pruned) in this call.' },
          firstSeq: { type: 'integer' },
          lastSeq: { type: 'integer' },
          headHash: { type: 'string', description: 'Hash of the last archived entry — the anchor the retained chain links to.' },
          archiveFile: { type: 'string' },
          archiveDir: { type: 'string' },
          pruned: { type: 'integer' },
          continuityOk: { type: 'boolean', description: 'Retained chain starts exactly where the archive ended.' },
          moreMayRemain: { type: 'boolean', description: 'True when more entries are older than the cutoff (call again).' },
          cutoffMs: { type: 'integer' },
          reason: { type: 'string', description: 'Present when nothing was archived.' },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'Invalid request body (missing fields, bad values). Nothing was stored.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: {
        description: 'Missing or invalid API key (auth on). The attempt is audited as AUTH_FAILED.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Valid key, but not allowed: acting as another agent, admin surface without the operator key, or a scope the key lacks.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Unknown id (intent, policy version, or API key). Nothing was changed.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NodeFailed: {
        description: 'The node call failed (unknown asset/root, or a node error). Nothing was executed.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
};

/**
 * The spec's route set as `METHOD /path` keys (OpenAPI `{param}` form),
 * for the drift test: every key must match a route registered in
 * `src/server.ts`, and vice versa.
 */
export function openApiRouteKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of Object.keys(item)) {
      keys.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys;
}
