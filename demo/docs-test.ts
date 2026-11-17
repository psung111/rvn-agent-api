/**
 * docs-test: checks for the generated HTML docs page (v0.33.0).
 *
 *  pnpm test:docs
 *
 *  - renderDocsHtml units (no API needed): the page for the real spec
 *    lists every spec operation (method + path), the package version, a
 *    link to /v1/openapi.json, every reason code, and the Decision schema
 *    properties; markup in a crafted document is escaped (never rendered
 *    as markup); a minimal doc with no tags/paths still renders; an
 *    unknown $ref renders its name instead of crashing
 *  - booted-API integration (MOCK_RVN=true): GET /v1/docs returns 200
 *    text/html containing the version and every spec path; on a second,
 *    auth-on API the docs page stays open without a key while
 *    /v1/metrics 401s (the exemption is specific, not auth broken)
 *
 * Nothing touches the network: the API is localhost-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openApiDocument } from '../src/openapi.js';
import { renderDocsHtml, type OpenApiDocLike } from '../src/docs.js';

const repo = process.cwd();
const tsx = join(repo, 'node_modules', '.bin', 'tsx');

const API1_PORT = 3135;
const API1 = `http://127.0.0.1:${API1_PORT}`;
const API2_PORT = 3136;
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

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

async function main(): Promise<void> {
  const doc: any = openApiDocument;
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));

  // ---- 0. render units (no API needed) ----
  const html = renderDocsHtml(doc);
  check('page title carries the package name and version',
    html.includes(`<title>rvn-agent-api ${pkg.version} — API docs</title>`), html.slice(0, 200));
  check('page links to the machine-readable contract', html.includes('href="/v1/openapi.json"'));
  check('page is a single self-contained document (no external assets)',
    !/src="http|<link rel="stylesheet"|@import|url\(http/.test(html), html.match(/src="http[^"]*|<link rel="stylesheet"[^>]*/)?.[0]);

  // Every spec operation appears with its method badge and path.
  const missingOps: string[] = [];
  let opCount = 0;
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of Object.keys(item).filter((m) => HTTP_METHODS.includes(m))) {
      opCount++;
      const badge = `<span class="method ${method}">${method.toUpperCase()}</span>`;
      if (!html.includes(badge) || !html.includes(`<span class="op-path">${path}</span>`)) {
        missingOps.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  check(`page lists every spec operation (${opCount} operations)`, missingOps.length === 0, missingOps);

  // Decision model: every reason code and the Decision schema properties.
  const codes = (doc.components?.schemas?.Decision?.properties?.reasonCodes?.items?.enum ?? []) as string[];
  const missingCodes = codes.filter((c) => !html.includes(`<code>${c}</code>`));
  check(`page lists every reason code (${codes.length} codes)`, codes.length > 0 && missingCodes.length === 0, missingCodes);
  const decisionProps = Object.keys(doc.components?.schemas?.Decision?.properties ?? {});
  const missingProps = decisionProps.filter((p) => !html.includes(`<code>${p}</code>`));
  check('page renders the Decision schema properties', decisionProps.length > 0 && missingProps.length === 0, missingProps);
  check('page has the decision-model section', html.includes('<h2>Decision model</h2>'));

  // Escaping: markup in a crafted document renders as text, never as markup.
  const hostile: OpenApiDocLike = {
    openapi: '3.0.3',
    info: { title: 'evil<title>', version: '0.0.0', description: '<script>alert("x")</script>' },
    tags: [{ name: 'Test', description: '"><img src=x onerror=alert(1)>' }],
    paths: {
      '/v1/evil': {
        get: {
          tags: ['Test'],
          summary: '<b>bold</b>',
          description: '<script>alert(1)</script>',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Broken' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Broken: { type: 'object', properties: { ref: { $ref: '#/components/schemas/NoSuchSchema' } } },
      },
    },
  };
  const hostileHtml = renderDocsHtml(hostile);
  check('hostile markup is escaped, never rendered',
    hostileHtml.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;') &&
    !hostileHtml.includes('<script>alert') &&
    hostileHtml.includes('&lt;b&gt;bold&lt;/b&gt;') &&
    !hostileHtml.includes('<b>bold</b>'),
    hostileHtml.slice(0, 500));
  check('unknown $ref renders its name instead of crashing',
    hostileHtml.includes('NoSuchSchema'), hostileHtml.slice(0, 300));

  // A minimal doc with no tags/paths still renders.
  const minimalHtml = renderDocsHtml({ info: { title: 'bare', version: '0.0.1' } });
  check('minimal doc renders without throwing', minimalHtml.includes('<title>bare 0.0.1 — API docs</title>'));

  // ---- 1. booted-API integration ----
  const api1 = await bootApi(API1_PORT);
  try {
    const res = await fetch(`${API1}/v1/docs`);
    const body = await res.text();
    check('GET /v1/docs returns 200 text/html',
      res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/html'),
      { status: res.status, contentType: res.headers.get('content-type') });
    check('served page matches the rendered spec',
      body === html, { servedLength: body.length, renderedLength: html.length });
    const missingPaths = Object.keys(doc.paths ?? {}).filter((p) => !body.includes(p));
    check(`served page lists every spec path (${Object.keys(doc.paths ?? {}).length} paths)`,
      missingPaths.length === 0, missingPaths);
  } finally {
    api1.kill();
  }

  // ---- 2. auth-on API: the docs page stays public, the rest stays gated ----
  const api2 = await bootApi(API2_PORT, {
    RVN_AUTH_ENABLED: 'true',
    RVN_OPERATOR_API_KEY: 'rvn_test-operator-key-long-enough',
  });
  try {
    const open = await fetch(`${API2}/v1/docs`);
    const openBody = await open.text();
    const gated = await fetch(`${API2}/v1/metrics`);
    check('auth-on: /v1/docs is open without a key',
      open.status === 200 && openBody.includes(`rvn-agent-api ${pkg.version}`), open.status);
    check('auth-on: /v1/metrics still 401s without a key', gated.status === 401, gated.status);
  } finally {
    api2.kill();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall docs checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
