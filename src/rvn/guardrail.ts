/**
 * Mainnet guardrail (v0.40.0): "never touch mainnet" is a hard rule, but
 * until now it rested on the operator pointing the API at the right node.
 * At boot the server asks the node for its chain (`getblockchaininfo`)
 * and refuses to start against `main` unless the operator explicitly
 * opts in with RVN_ALLOW_MAINNET=true — a misconfigured RPC URL fails
 * loudly at startup instead of moving real funds.
 *
 * The check is pure and testable: the server calls `checkChainGuardrail`
 * with the chain the node reported. A node that cannot answer at boot
 * leaves the chain unverified (logged loudly) and the API still boots —
 * an unreachable node cannot move funds, and submits against it fail
 * with 502 — but a node that answers `main` without the opt-in stops
 * the process with a MainnetGuardrailError before any route is served.
 */

export class MainnetGuardrailError extends Error {
  constructor(chain: string) {
    super(
      `refusing to boot against Ravencoin mainnet (chain '${chain}'): ` +
        `set RVN_ALLOW_MAINNET=true to opt in explicitly`,
    );
    this.name = 'MainnetGuardrailError';
  }
}

/**
 * The explicit mainnet opt-in: only the literal 'true' counts, like
 * RVN_AUTH_ENABLED — anything else (unset, 'false', '1', 'TRUE') keeps
 * the guardrail on, so a half-set env var can never silently open
 * mainnet.
 */
export function mainnetAllowedFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RVN_ALLOW_MAINNET === 'true';
}

/** True exactly for Ravencoin's main chain — the name ravend reports. */
export function isMainnetChain(chain: string): boolean {
  return chain === 'main';
}

/**
 * Enforce the guardrail on the chain the node reported at boot.
 * Throws MainnetGuardrailError on mainnet without the opt-in; every
 * other chain (test, regtest, mock, …) passes unchanged.
 */
export function checkChainGuardrail(chain: string, allowMainnet: boolean): void {
  if (isMainnetChain(chain) && !allowMainnet) {
    throw new MainnetGuardrailError(chain);
  }
}
