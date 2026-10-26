import type { RvnPolicy } from './types.js';

/**
 * Policy preset gallery. A preset is a named, opinionated starting policy;
 * applying one to an agent (optionally with per-agent overrides) replaces
 * that agent's policy wholesale — the same semantics as PUT
 * /v1/policies/:agentId, without hand-writing every field.
 *
 *   conservative — tight caps, low approval thresholds, empty allowlist:
 *     almost anything non-trivial needs a human.
 *   balanced     — the Phase-0 default: caps high enough to demo every
 *     decision path, thresholds that still route large ops to approval.
 *   permissive   — high caps, high thresholds, wildcard allowlist: only
 *     very large ops need approval. For trusted agents only.
 */
export interface PolicyPreset {
  id: string;
  name: string;
  description: string;
  /** Policy fields with agentId left as '*' — filled in at apply time. */
  policy: Omit<RvnPolicy, 'agentId'> & { agentId: '*' };
}

function preset(
  id: string,
  name: string,
  description: string,
  policy: Omit<RvnPolicy, 'version' | 'agentId'>,
): PolicyPreset {
  return { id, name, description, policy: { version: 1, agentId: '*', ...policy } };
}

export const POLICY_PRESETS: PolicyPreset[] = [
  preset(
    'conservative',
    'Conservative',
    'Tight caps, low approval thresholds, empty allowlist — almost anything non-trivial needs a human.',
    {
      maxIssueQtyBaseUnits: '10000',
      approvalAboveIssueQtyBaseUnits: '1000',
      dailyIssueBudgetBaseUnits: '50000',
      maxTransferQtyBaseUnits: '5000',
      approvalAboveTransferQtyBaseUnits: '500',
      allowedDestinations: [],
      blockedDestinations: [],
      assetNamePattern: '^[A-Z0-9._]{3,30}$',
      decisionTtlSeconds: 60,
    },
  ),
  preset(
    'balanced',
    'Balanced',
    'The Phase-0 default: caps high enough to demo every decision path, thresholds that still route large ops to approval.',
    {
      maxIssueQtyBaseUnits: '100000',
      approvalAboveIssueQtyBaseUnits: '10000',
      dailyIssueBudgetBaseUnits: '500000',
      maxTransferQtyBaseUnits: '50000',
      approvalAboveTransferQtyBaseUnits: '5000',
      allowedDestinations: [],
      blockedDestinations: [],
      assetNamePattern: '^[A-Z0-9._]{3,30}$',
      decisionTtlSeconds: 60,
    },
  ),
  preset(
    'permissive',
    'Permissive',
    'High caps, high thresholds, wildcard allowlist — only very large ops need approval. For trusted agents only.',
    {
      maxIssueQtyBaseUnits: '10000000',
      approvalAboveIssueQtyBaseUnits: '1000000',
      dailyIssueBudgetBaseUnits: '100000000',
      maxTransferQtyBaseUnits: '1000000',
      approvalAboveTransferQtyBaseUnits: '100000',
      allowedDestinations: ['*'],
      blockedDestinations: [],
      assetNamePattern: '^[A-Z0-9._]{3,30}$',
      decisionTtlSeconds: 3600,
    },
  ),
];

export function findPreset(id: string): PolicyPreset | undefined {
  return POLICY_PRESETS.find((p) => p.id === id);
}

/** Fields an apply-time override may touch. version/agentId are not overridable. */
const OVERRIDABLE_QTY_FIELDS = [
  'maxIssueQtyBaseUnits',
  'approvalAboveIssueQtyBaseUnits',
  'dailyIssueBudgetBaseUnits',
  'maxTransferQtyBaseUnits',
  'approvalAboveTransferQtyBaseUnits',
] as const;
const OVERRIDABLE_LIST_FIELDS = ['allowedDestinations', 'blockedDestinations'] as const;

/**
 * Build the policy an agent gets from a preset plus per-agent overrides.
 * Throws an Error (surfaced as a 400 by the route) on an unknown preset,
 * an unknown override field, or a malformed override value — so a typo
 * can never silently half-apply.
 */
export function applyPreset(
  presetId: string,
  agentId: string,
  overrides: Record<string, unknown> = {},
): RvnPolicy {
  const found = findPreset(presetId);
  if (!found) {
    throw new Error(
      `unknown preset: '${presetId}' (known presets: ${POLICY_PRESETS.map((p) => p.id).join(', ')})`,
    );
  }
  const merged: Record<string, unknown> = { ...found.policy, agentId };
  for (const [key, value] of Object.entries(overrides)) {
    if ((OVERRIDABLE_QTY_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'string') {
        throw new Error(`override '${key}' must be a decimal string in base units`);
      }
      try {
        const n = BigInt(value);
        if (n < 0n) throw new Error('negative');
      } catch {
        throw new Error(`override '${key}' must be a non-negative integer decimal string`);
      }
    } else if ((OVERRIDABLE_LIST_FIELDS as readonly string[]).includes(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new Error(`override '${key}' must be an array of address strings`);
      }
    } else if (key === 'assetNamePattern') {
      if (typeof value !== 'string') {
        throw new Error(`override 'assetNamePattern' must be a regex string`);
      }
      try {
        new RegExp(value);
      } catch {
        throw new Error(`override 'assetNamePattern' is not a valid regex`);
      }
    } else if (key === 'decisionTtlSeconds') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`override 'decisionTtlSeconds' must be a positive integer`);
      }
    } else {
      throw new Error(
        `unknown override field: '${key}' (overridable: ${[...OVERRIDABLE_QTY_FIELDS, ...OVERRIDABLE_LIST_FIELDS, 'assetNamePattern', 'decisionTtlSeconds'].join(', ')})`,
      );
    }
    merged[key] = value;
  }
  return merged as unknown as RvnPolicy;
}

/**
 * Sensible Phase-0 default. Units here are whole asset units (units=0), so
 * "1000" means one thousand tokens. Tight enough to demo every decision path.
 */
export function defaultPolicy(agentId = '*'): RvnPolicy {
  return {
    version: 1,
    agentId,
    maxIssueQtyBaseUnits: '100000', // hard ceiling per issue op
    approvalAboveIssueQtyBaseUnits: '10000', // above -> human approval
    dailyIssueBudgetBaseUnits: '500000', // rolling 24h per agent
    maxTransferQtyBaseUnits: '50000',
    approvalAboveTransferQtyBaseUnits: '5000',
    allowedDestinations: [], // empty = nothing pre-approved -> transfers need approval
    blockedDestinations: [],
    assetNamePattern: '^[A-Z0-9._]{3,30}$', // Ravencoin asset naming rules
    decisionTtlSeconds: 60,
  };
}
