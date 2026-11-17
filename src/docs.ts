/**
 * Human-readable API docs, generated from the OpenAPI contract (v0.33.0).
 *
 * `renderDocsHtml(openApiDocument)` turns the hand-maintained document in
 * `src/openapi.ts` into a single self-contained HTML page — no external
 * assets, no JavaScript, no CDN — served at GET /v1/docs. The page is
 * regenerated from the spec on every request, so it can never drift from
 * the contract the way a separately maintained docs page would; the drift
 * test (`pnpm test:openapi`) already asserts the spec matches the server,
 * and `pnpm test:docs` asserts the page lists every spec operation.
 *
 * Pure function: no I/O, no server state. Everything from the document is
 * HTML-escaped — a description containing markup renders as text, never
 * as markup.
 */

type JsonObject = Record<string, unknown>;

/** The parts of an OpenAPI document the renderer reads. */
export interface OpenApiDocLike {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  tags?: Array<{ name: string; description?: string }>;
  paths?: Record<string, Record<string, JsonObject>>;
  components?: { schemas?: Record<string, JsonObject>; responses?: Record<string, JsonObject> };
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** The decision kinds, for the "Decision model" section header. */
const DECISION_KINDS = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Resolve a `#/components/schemas/<Name>` ref inside the document. */
function resolveRef(ref: string, doc: OpenApiDocLike): { name: string; schema: JsonObject } | undefined {
  const m = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!m) return undefined;
  const schema = doc.components?.schemas?.[m[1]];
  if (!schema || typeof schema !== 'object') return undefined;
  return { name: m[1], schema: schema as JsonObject };
}

/**
 * Render one JSON schema as a compact readable fragment: primitives as
 * `<code>type</code>`, objects as a property list, arrays as "array of …",
 * enums as their values, and $refs by name with one level of inlining.
 * Depth- and cycle-guarded: a ref already on the current path, or deeper
 * than two inlines, renders as just its name.
 */
function renderSchema(schema: unknown, doc: OpenApiDocLike, depth: number, seen: Set<string>): string {
  if (schema === null || typeof schema !== 'object') return '<code>any</code>';
  const s = schema as JsonObject;
  if (typeof s.$ref === 'string') {
    const resolved = resolveRef(s.$ref, doc);
    if (!resolved) return `<code>${escapeHtml(s.$ref)}</code>`;
    if (seen.has(resolved.name) || depth >= 2) return `<code>${escapeHtml(resolved.name)}</code>`;
    const nextSeen = new Set(seen);
    nextSeen.add(resolved.name);
    const inner = renderSchema(resolved.schema, doc, depth + 1, nextSeen);
    return `<code>${escapeHtml(resolved.name)}</code> ${inner}`;
  }
  const type = asString(s.type) || 'any';
  const desc = asString(s.description);
  const descHtml = desc ? ` — ${escapeHtml(desc)}` : '';
  if (Array.isArray(s.enum)) {
    const values = s.enum.map((v) => `<code>${escapeHtml(String(v))}</code>`).join(', ');
    return `<code>${escapeHtml(type)}</code>: one of ${values}${descHtml}`;
  }
  if (type === 'array') {
    return `<code>array</code> of ${renderSchema(s.items, doc, depth, seen)}${descHtml}`;
  }
  if (type === 'object' && s.properties !== null && typeof s.properties === 'object') {
    const required = new Set<string>(Array.isArray(s.required) ? (s.required as unknown[]).filter((r): r is string => typeof r === 'string') : []);
    const props = Object.entries(s.properties as Record<string, JsonObject>);
    if (props.length === 0) return `<code>object</code>${descHtml}`;
    const rows = props
      .map(([name, prop]) => {
        const req = required.has(name) ? ' <em>required</em>' : '';
        return `<li><code>${escapeHtml(name)}</code>${req} (${renderSchema(prop, doc, depth, seen)})</li>`;
      })
      .join('');
    return `<code>object</code>${descHtml}<ul>${rows}</ul>`;
  }
  return `<code>${escapeHtml(type)}</code>${descHtml}`;
}

function methodBadge(method: string): string {
  const cls = { get: 'get', post: 'post', put: 'put', delete: 'delete' }[method] ?? 'other';
  return `<span class="method ${cls}">${escapeHtml(method.toUpperCase())}</span>`;
}

function renderParameters(op: JsonObject): string {
  const params = Array.isArray(op.parameters) ? (op.parameters as JsonObject[]) : [];
  if (params.length === 0) return '';
  const rows = params
    .map((p) => {
      const schema = (p.schema ?? {}) as JsonObject;
      return `<tr><td><code>${escapeHtml(asString(p.name))}</code></td><td>${escapeHtml(asString(p.in))}</td><td>${p.required === true ? 'yes' : 'no'}</td><td>${escapeHtml(asString(schema.type))}</td><td>${escapeHtml(asString(p.description) || asString(schema.description))}</td></tr>`;
    })
    .join('');
  return `<h4>Parameters</h4><table><tr><th>Name</th><th>In</th><th>Required</th><th>Type</th><th>Description</th></tr>${rows}</table>`;
}

function renderRequestBody(op: JsonObject, doc: OpenApiDocLike): string {
  const body = op.requestBody;
  if (body === null || typeof body !== 'object') return '';
  const b = body as JsonObject;
  const content = b.content;
  if (content === null || typeof content !== 'object') return '';
  const first = Object.entries(content as Record<string, JsonObject>)[0];
  if (!first) return '';
  const [mediaType, media] = first;
  const schema = (media as JsonObject).schema;
  const req = b.required === true ? ' <em>required</em>' : '';
  return `<h4>Request body${req} <code>${escapeHtml(mediaType)}</code></h4><p>${escapeHtml(asString(b.description))}</p>${renderSchema(schema, doc, 0, new Set())}`;
}

function renderResponses(op: JsonObject, doc: OpenApiDocLike): string {
  const responses = op.responses;
  if (responses === null || typeof responses !== 'object') return '';
  const rows = Object.entries(responses as Record<string, JsonObject>)
    .map(([status, r]) => {
      const content = r.content;
      let schemaHtml = '';
      if (content !== null && typeof content === 'object') {
        const first = Object.entries(content as Record<string, JsonObject>)[0];
        if (first) {
          schemaHtml = `<br>${renderSchema((first[1] as JsonObject).schema, doc, 0, new Set())}`;
        }
      }
      return `<tr><td><code>${escapeHtml(status)}</code></td><td>${escapeHtml(asString(r.description))}${schemaHtml}</td></tr>`;
    })
    .join('');
  return `<h4>Responses</h4><table><tr><th>Status</th><th>Description</th></tr>${rows}</table>`;
}

/** The reason-code enum from the Decision schema, when the spec declares it. */
function decisionReasonCodes(doc: OpenApiDocLike): string[] {
  const decision = doc.components?.schemas?.Decision;
  if (decision === null || typeof decision !== 'object') return [];
  const props = (decision as JsonObject).properties;
  if (props === null || typeof props !== 'object') return [];
  const reasonCodes = (props as Record<string, JsonObject>).reasonCodes;
  if (reasonCodes === null || typeof reasonCodes !== 'object') return [];
  const items = (reasonCodes as JsonObject).items;
  if (items === null || typeof items !== 'object') return [];
  const en = (items as JsonObject).enum;
  return Array.isArray(en) ? en.filter((c): c is string => typeof c === 'string') : [];
}

const CSS = [
  'body{font-family:system-ui,-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5}',
  'h1{font-size:1.6em;margin-bottom:0}h2{border-bottom:2px solid #ddd;padding-bottom:4px;margin-top:2em}',
  'h3{margin-top:1.5em}.meta{color:#555}',
  'code{background:#f2f2f2;padding:1px 5px;border-radius:3px;font-size:.92em}',
  'pre{background:#f2f2f2;padding:12px;border-radius:4px;overflow-x:auto}',
  'table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7}',
  '.method{display:inline-block;min-width:52px;text-align:center;color:#fff;font-weight:700;font-size:.8em;padding:2px 8px;border-radius:3px;margin-right:8px}',
  '.get{background:#2e7d32}.post{background:#1565c0}.put{background:#b26a00}.delete{background:#b71c1c}.other{background:#666}',
  '.op-path{font-family:monospace;font-size:1.05em}ul{margin:4px 0}',
].join('\n');

export function renderDocsHtml(doc: OpenApiDocLike): string {
  const title = doc.info?.title ?? 'API';
  const version = doc.info?.version ?? '';
  const description = doc.info?.description ?? '';
  const declaredTags = (doc.tags ?? []).map((t) => t.name);
  const tagDescriptions = new Map((doc.tags ?? []).map((t) => [t.name, t.description ?? '']));

  // Group operations by their first tag, in declared tag order; untagged
  // (or unknown-tagged) operations fall under "Other" at the end.
  const groups = new Map<string, Array<{ method: string; path: string; op: JsonObject }>>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item).filter((m) => HTTP_METHODS.includes(m))) {
      const op = item[method] as JsonObject;
      const tags = Array.isArray(op.tags) ? (op.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      const tag = tags.find((t) => declaredTags.includes(t)) ?? 'Other';
      const list = groups.get(tag) ?? [];
      list.push({ method, path, op });
      groups.set(tag, list);
    }
  }
  const orderedTags = [...declaredTags.filter((t) => groups.has(t)), ...[...groups.keys()].filter((t) => !declaredTags.includes(t))];

  const reasonCodes = decisionReasonCodes(doc);
  const reasonSection =
    reasonCodes.length === 0
      ? ''
      : `<h2>Decision model</h2><p>Every submit is evaluated against the agent's policy and returns a decision of kind ` +
        DECISION_KINDS.map((k) => `<code>${k}</code>`).join(', ') +
        ` — ALLOW executes immediately, REQUIRE_APPROVAL holds the intent for a human approver, DENY refuses it. The decision carries one or more reason codes:</p>` +
        `<table><tr><th>Reason code</th></tr>${reasonCodes.map((c) => `<tr><td><code>${escapeHtml(c)}</code></td></tr>`).join('')}</table>`;

  const sections = orderedTags
    .map((tag) => {
      const ops = groups.get(tag) ?? [];
      const tagDesc = tagDescriptions.get(tag);
      const header = `<h2>${escapeHtml(tag)}</h2>${tagDesc ? `<p class="meta">${escapeHtml(tagDesc)}</p>` : ''}`;
      const opHtml = ops
        .map(({ method, path, op }) => {
          const summary = asString(op.summary);
          const desc = asString(op.description);
          return (
            `<h3>${methodBadge(method)}<span class="op-path">${escapeHtml(path)}</span>${summary ? ` — ${escapeHtml(summary)}` : ''}</h3>` +
            (desc ? `<p>${escapeHtml(desc)}</p>` : '') +
            renderParameters(op) +
            renderRequestBody(op, doc) +
            renderResponses(op, doc)
          );
        })
        .join('');
      return header + opHtml;
    })
    .join('');

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)} ${escapeHtml(version)} — API docs</title><style>${CSS}</style></head><body>` +
    `<h1>${escapeHtml(title)} <span class="meta">v${escapeHtml(version)}</span></h1>` +
    (description ? `<p>${escapeHtml(description)}</p>` : '') +
    `<p>Machine-readable contract: <a href="/v1/openapi.json">/v1/openapi.json</a> (OpenAPI ${escapeHtml(doc.openapi ?? '')}). ` +
    `This page is generated from that contract on every request, so it can never drift from it.</p>` +
    reasonSection +
    sections +
    `<hr><p class="meta">Generated from the OpenAPI contract — see <a href="/v1/openapi.json">/v1/openapi.json</a> for the machine-readable version.</p>` +
    `</body></html>`
  );
}
