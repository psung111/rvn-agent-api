/**
 * guardrail-test: checks for the mainnet guardrail (v0.40.0).
 *
 *  pnpm test:guardrail
 *
 * Units: mainnetAllowedFromEnv (only the literal 'true' opts in),
 * isMainnetChain, checkChainGuardrail (throws MainnetGuardrailError on
 * mainnet without the opt-in, passes every other chain, and the error
 * names the opt-in), and the mock's MOCK_CHAIN env (default 'mock',
 * 'main' / 'test' pass through, empty falls back).
 *
 * Integration: boots the real API as a child process (MOCK_RVN=true)
 * and asserts:
 *   - MOCK_CHAIN=main with no opt-in: the process exits 1 before
 *     serving anything — /v1/health never answers — and stderr names
 *     the guardrail and RVN_ALLOW_MAINNET
 *   - MOCK_CHAIN=main with RVN_ALLOW_MAINNET=true: boots, and
 *     /v1/health reports chain 'main'
 *   - MOCK_CHAIN=test: boots, health reports chain 'test'
 *   - default mock: boots, health reports chain 'mock'
 *
 * Nothing touches the network: the API is localhost-only, and the
 * guardrail is exercised against the mock node, never a live ravend.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MockRvnNode } from '../src/rvn/mock.js';
import {
  checkChainGuardrail,
  isMainnetChain,
  mainnetAllowedFromEnv,
  MainnetGuardrailError,
} from '../src/rvn/guardrail.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const MAIN_PORT = 3150;
const TEST_PORT = 3151;
const MOCK_PORT = 3152;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Units: env parsing -------------------------------------------------

check('opt-in unset is false', mainnetAllowedFromEnv({}) === false);
check("opt-in 'true' is true", mainnetAllowedFromEnv({ RVN_ALLOW_MAINNET: 'true' }) === true);
check("opt-in 'false' is false", mainnetAllowedFromEnv({ RVN_ALLOW_MAINNET: 'false' }) === false);
check("opt-in 'TRUE' is false (exact match only)", mainnetAllowedFromEnv({ RVN_ALLOW_MAINNET: 'TRUE' }) === false);
check("opt-in '1' is false", mainnetAllowedFromEnv({ RVN_ALLOW_MAINNET: '1' }) === false);
check("opt-in '' is false", mainnetAllowedFromEnv({ RVN_ALLOW_MAINNET: '' }) === false);

// --- Units: chain check --------------------------------------------------

check("isMainnetChain('main')", isMainnetChain('main') === true);
check("isMainnetChain('test') is false", isMainnetChain('test') === false);
check("isMainnetChain('regtest') is false", isMainnetChain('regtest') === false);
check("isMainnetChain('mock') is false", isMainnetChain('mock') === false);
check("isMainnetChain('') is false", isMainnetChain('') === false);

function throwsGuardrail(chain: string, allow: boolean): Error | null {
  try {
    checkChainGuardrail(chain, allow);
    return null;
  } catch (err) {
    return err as Error;
  }
}

const mainnetErr = throwsGuardrail('main', false);
check(
  "mainnet without the opt-in throws MainnetGuardrailError",
  mainnetErr instanceof MainnetGuardrailError && mainnetErr.name === 'MainnetGuardrailError',
  mainnetErr,
);
check(
  'guardrail error names the opt-in env var',
  mainnetErr !== null && mainnetErr.message.includes('RVN_ALLOW_MAINNET=true'),
  mainnetErr?.message,
);
check(
  'guardrail error names the chain',
  mainnetErr !== null && mainnetErr.message.includes("'main'"),
  mainnetErr?.message,
);
check('mainnet with the opt-in passes', throwsGuardrail('main', true) === null);
check('test passes without the opt-in', throwsGuardrail('test', false) === null);
check('regtest passes without the opt-in', throwsGuardrail('regtest', false) === null);
check('mock passes without the opt-in', throwsGuardrail('mock', false) === null);

// --- Units: mock chain from env ------------------------------------------

async function mockChain(envValue: string | undefined): Promise<string> {
  const prev = process.env.MOCK_CHAIN;
  if (envValue === undefined) delete process.env.MOCK_CHAIN;
  else process.env.MOCK_CHAIN = envValue;
  try {
    return (await new MockRvnNode().getInfo()).chain;
  } finally {
    if (prev === undefined) delete process.env.MOCK_CHAIN;
    else process.env.MOCK_CHAIN = prev;
  }
}

check('mock default chain is mock', (await mockChain(undefined)) === 'mock');
check("mock MOCK_CHAIN=main reports main", (await mockChain('main')) === 'main');
check("mock MOCK_CHAIN=test reports test", (await mockChain('test')) === 'test');
check('mock empty MOCK_CHAIN falls back to mock', (await mockChain('')) === 'mock');
check('mock whitespace MOCK_CHAIN falls back to mock', (await mockChain('   ')) === 'mock');
check('mock MOCK_CHAIN trims whitespace', (await mockChain(' main ')) === 'main');

// --- Integration: booted API ----------------------------------------------

interface Spawned {
  child: ChildProcess;
  stderr: string;
}

function spawnApi(port: number, extraEnv: Record<string, string> = {}): Spawned {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(port), MOCK_RVN: 'true', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
  } as Spawned;
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<Record<string, any> | null> {
  const api = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${api}/v1/health`);
      if (r.ok) return (await r.json()) as Record<string, any>;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return null;
}

async function waitForExit(child: ChildProcess, timeoutMs = 15000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return child.exitCode;
    await sleep(250);
  }
  return null;
}

const children: ChildProcess[] = [];
try {
  // 1. Mainnet mock, no opt-in: refuses to boot.
  const refused = spawnApi(MAIN_PORT, { MOCK_CHAIN: 'main' });
  children.push(refused.child);
  const refusedHealth = await waitForHealth(MAIN_PORT, 5000);
  const refusedCode = await waitForExit(refused.child, 15000);
  check('mainnet mock without the opt-in never serves /v1/health', refusedHealth === null);
  check('mainnet mock without the opt-in exits 1', refusedCode === 1, refusedCode);
  check(
    'refusal stderr names the guardrail',
    refused.stderr.includes('MainnetGuardrailError') || refused.stderr.includes('mainnet'),
    refused.stderr.slice(0, 500),
  );
  check(
    'refusal stderr names the opt-in',
    refused.stderr.includes('RVN_ALLOW_MAINNET=true'),
    refused.stderr.slice(0, 500),
  );

  // 2. Mainnet mock, opted in: boots and reports chain 'main'.
  const allowed = spawnApi(MAIN_PORT, { MOCK_CHAIN: 'main', RVN_ALLOW_MAINNET: 'true' });
  children.push(allowed.child);
  const allowedHealth = await waitForHealth(MAIN_PORT);
  check('mainnet mock with the opt-in boots', allowedHealth !== null);
  check("opted-in health reports chain 'main'", allowedHealth?.chain === 'main', allowedHealth);
  check('opted-in health still reports mock mode', allowedHealth?.mock === true, allowedHealth);
  allowed.child.kill();
  await waitForExit(allowed.child);

  // 3. Testnet mock: boots, health reports chain 'test'.
  const testnet = spawnApi(TEST_PORT, { MOCK_CHAIN: 'test' });
  children.push(testnet.child);
  const testHealth = await waitForHealth(TEST_PORT);
  check('testnet mock boots without the opt-in', testHealth !== null);
  check("testnet health reports chain 'test'", testHealth?.chain === 'test', testHealth);
  testnet.child.kill();
  await waitForExit(testnet.child);

  // 4. Default mock: boots, health reports chain 'mock'.
  const mock = spawnApi(MOCK_PORT);
  children.push(mock.child);
  const mockHealth = await waitForHealth(MOCK_PORT);
  check('default mock boots', mockHealth !== null);
  check("default health reports chain 'mock'", mockHealth?.chain === 'mock', mockHealth);
  check('default health reports block height', typeof mockHealth?.blocks === 'number', mockHealth);
  mock.child.kill();
  await waitForExit(mock.child);
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll guardrail checks passed');
