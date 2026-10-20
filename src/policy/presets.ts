import type { RvnPolicy } from './types.js';

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
