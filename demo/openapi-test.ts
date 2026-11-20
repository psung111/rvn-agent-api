/**
 * openapi-test: checks for the OpenAPI contract (v0.32.0).
 *
 *  pnpm test:openapi
 *
 *  - document shape (no API needed): OpenAPI 3.0.3, info.version matches
 *    package.json, every path has an operation with a summary and responses,
 *    every operation tag exists, every $ref resolves to a declared component,
 *    every {param} in a path is declared, and the reason-code enum covers
 *    every code the policy evaluator and the server gates can emit
 *  - drift: the route registrations parsed out of src/server.ts
 *    (app.get/post/put/delete) must be exactly the spec's method+path set,
 *    in both directions — a route added without a spec entry, or a spec
 *    entry for a removed route, fails here
 *  - booted-API integration (MOCK_RVN=true): GET /v1/openapi.json serves
 *    the document verbatim; every spec operation is probed against the live
 *    server and must not answer with Fastify's route-not-found 404
 *    (a 400/403/404-with-our-own-error proves the route exists); and on a
 *    second, auth-on API the contract stays open without a key while
 *    /v1/metrics 401s (the exemption is specific, not auth broken)
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openApiDocument, openApiRouteKeys, REASON_CODES } from '../src/openapi.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3133;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2_PORT = 3134;
const API2 = `http://127.0.0.1:${API2_PORT}`;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function bootApi(port: number, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(tsx, [join(repo, 'src', 'server.ts')], {
    env: { ...process.env, PORT: String(port), MOCK_RVN: 'true', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('API did not come up in time');
}

function makeReq(base: string) {
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  return {
    get: (path: string, headers?: Record<string, string>) => req('GET', path, undefined, headers),
    post: (path: string, body: unknown, headers?: Record<string, string>) => req('POST', path, body, headers),
    put: (path: string, body: unknown, headers?: Record<string, string>) => req('PUT', path, body, headers),
  };
}

/** Collect every $ref string in a JSON value, recursively. */
function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

/** Route registrations parsed out of src/server.ts, as `METHOD /path` keys. */
function serverRouteKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const re = /app\.(get|post|put|delete)\('([^']+)'/g;
  for (const m of source.matchAll(re)) {
    const path = m[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    keys.add(`${m[1].toUpperCase()} ${path}`);
  }
  return keys;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

async function main(): Promise<void> {
  const doc: any = openApiDocument;

  // ---- 0. document shape (no API needed) ----
  check('document is OpenAPI 3.0.3', doc.openapi === '3.0.3', doc.openapi);
  check('info.title is rvn-agent-api', doc.info?.title === 'rvn-agent-api', doc.info?.title);
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  check('info.version matches package.json', doc.info?.version === pkg.version, `${doc.info?.version} vs ${pkg.version}`);

  const declaredTags = new Set<string>((doc.tags ?? []).map((t: any) => t.name));
  const refs = collectRefs(doc);
  const schemas = new Set<string>(Object.keys(doc.components?.schemas ?? {}));
  const responses = new Set<string>(Object.keys(doc.components?.responses ?? {}));
  let ops = 0;
  let shapeOk = true;
  const shapeProblems: string[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    const methods = Object.keys(item).filter((m) => HTTP_METHODS.includes(m));
    if (methods.length === 0) {
      shapeOk = false;
      shapeProblems.push(`${path}: no operations`);
    }
    for (const method of methods) {
      ops++;
      const op = item[method];
      if (typeof op.summary !== 'string' || !op.summary) {
        shapeOk = false;
        shapeProblems.push(`${method} ${path}: no summary`);
      }
      if (!op.responses || Object.keys(op.responses).length === 0) {
        shapeOk = false;
        shapeProblems.push(`${method} ${path}: no responses`);
      }
      for (const tag of op.tags ?? []) {
        if (!declaredTags.has(tag)) {
          shapeOk = false;
          shapeProblems.push(`${method} ${path}: unknown tag ${tag}`);
        }
      }
      const declaredParams = new Set<string>((op.parameters ?? []).map((p: any) => `${p.in}:${p.name}`));
      for (const m of path.matchAll(/\{([^}]+)\}/g)) {
        if (!declaredParams.has(`path:${m[1]}`)) {
          shapeOk = false;
          shapeProblems.push(`${method} ${path}: path param {${m[1]}} not declared`);
        }
      }
    }
  }
  check(`every path has an operation with summary, responses, known tags, declared params (${ops} operations)`, shapeOk, shapeProblems);
  const badRefs = refs.filter((r) => {
    const m = r.match(/^#\/components\/(schemas|responses)\/(.+)$/);
    if (!m) return true;
    return m[1] === 'schemas' ? !schemas.has(m[2]) : !responses.has(m[2]);
  });
  check(`every $ref resolves to a declared component (${refs.length} refs)`, badRefs.length === 0, badRefs);

  // Reason codes: every code the evaluator and the server gates can emit.
  const expectedCodes = [
    'WITHIN_POLICY',
    'DESTINATION_NOT_ALLOWLISTED', 'ABOVE_APPROVAL_THRESHOLD', 'ANOMALY_SUSPECTED', 'QUORUM_REQUIRED',
    'DESTINATION_BLOCKED', 'ASSET_NAME_REJECTED', 'NON_POSITIVE_QTY',
    'ISSUE_CAP_EXCEEDED', 'DAILY_ISSUE_BUDGET_EXCEEDED', 'TRANSFER_CAP_EXCEEDED',
    'INSUFFICIENT_ASSET_BALANCE', 'INSUFFICIENT_RVN_BALANCE',
    'RATE_LIMIT_EXCEEDED', 'DENIED_BY_OWNER', 'APPROVED',
  ];
  const codeSet = new Set<string>(REASON_CODES);
  const missingCodes = expectedCodes.filter((c) => !codeSet.has(c));
  const docCodes = (doc.components?.schemas?.Decision?.properties?.reasonCodes?.items?.enum ?? []) as string[];
  check('reason-code enum covers every code the evaluator and gates emit',
    missingCodes.length === 0 && expectedCodes.every((c) => docCodes.includes(c)),
    { missingCodes, inDocButNotExpected: docCodes.filter((c) => !expectedCodes.includes(c)) });

  // ---- 1. drift: server registrations vs spec ----
  const serverSource = await readFile(join(repo, 'src', 'server.ts'), 'utf8');
  const serverKeys = serverRouteKeys(serverSource);
  const specKeys = openApiRouteKeys();
  const inServerNotSpec = [...serverKeys].filter((k) => !specKeys.has(k));
  const inSpecNotServer = [...specKeys].filter((k) => !serverKeys.has(k));
  check(`spec routes == server routes (${specKeys.size} operations)`,
    inServerNotSpec.length === 0 && inSpecNotServer.length === 0,
    { inServerNotSpec, inSpecNotServer });

  // ---- 2. booted-API integration ----
  const api1 = await bootApi(API1_PORT);
  const req1 = makeReq(API1);
  try {
    const served = await req1.get('/v1/openapi.json');
    check('GET /v1/openapi.json serves the document verbatim',
      served.status === 200 && JSON.stringify(served.json) === JSON.stringify(doc),
      { status: served.status });
    check('served document is OpenAPI 3.0.3 with the package version',
      served.json?.openapi === '3.0.3' && served.json?.info?.version === pkg.version,
      served.json?.info);

    // Probe every spec operation: a route that exists answers with a
    // 400/403/404-with-our-own-error, never Fastify's route-not-found
    // 404 ({ error: 'Not Found', message: 'Route ... not found' }).
    const probeValues: Record<string, string> = { name: 'NOPE', id: 'nope-id', agentId: 'agent-1' };
    const probeProblems: string[] = [];
    for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
      for (const method of Object.keys(item).filter((m) => HTTP_METHODS.includes(m))) {
        const probePath = path.replace(/\{([^}]+)\}/g, (_, p) => probeValues[p] ?? 'x');
        const res = method === 'get'
          ? await req1.get(probePath)
          : method === 'put'
            ? await req1.put(probePath, {})
            : await req1.post(probePath, {});
        const routeMissing = res.status === 404 && res.json?.error === 'Not Found';
        if (routeMissing) probeProblems.push(`${method.toUpperCase()} ${path} -> Fastify 404`);
      }
    }
    check(`every spec operation resolves on the live server (${ops} probed)`, probeProblems.length === 0, probeProblems);
  } finally {
    api1.kill();
  }

  // ---- 3. auth-on API: the contract stays public, the rest stays gated ----
  const api2 = await bootApi(API2_PORT, {
    RVN_AUTH_ENABLED: 'true',
    RVN_OPERATOR_API_KEY: 'rvn_test-operator-key-long-enough',
  });
  const req2 = makeReq(API2);
  try {
    const open = await req2.get('/v1/openapi.json');
    const gated = await req2.get('/v1/metrics');
    check('auth-on: /v1/openapi.json is open without a key', open.status === 200 && open.json?.openapi === '3.0.3', open.status);
    check('auth-on: /v1/metrics still 401s without a key', gated.status === 401, gated.status);
  } finally {
    api2.kill();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall openapi checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
