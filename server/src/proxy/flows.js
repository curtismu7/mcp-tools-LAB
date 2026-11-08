// The proxy's flow log: the last MAX_FLOWS request/response pairs, in memory only (never written to disk, gone on
// restart, cleared by Reset). What is kept:
//  - only allowlisted headers; an Authorization header is never kept (the client's proxy token and the upstream token
//    are both replaced by a label);
//  - bodies capped at MAX_BODY bytes, with every secret of the target connection and the proxy token scrubbed out
//    before they are stored. Tokens inside a body that are not ours (for example a token a tool returns) stay raw:
//    this is a teaching tool (rule 4).
import { sseMessages } from '../mcp/http.js';
import { scrub } from '../redact.js';
import { estimateTokens } from './tokens.js';

export const MAX_FLOWS = 200;
export const MAX_BODY = 64 * 1024;
export const KEPT_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];

export function keptHeaders(headers, { authLabel } = {}) {
  const get = typeof headers?.get === 'function' ? (k) => headers.get(k) : (k) => headers?.[k];
  const out = {};
  for (const k of KEPT_HEADERS) { const v = get(k); if (v) out[k] = String(v).slice(0, 200); }
  if (authLabel) out.authorization = authLabel;
  return out;
}

// A captured body: the text (capped, scrubbed), the parsed JSON when it parses, or the JSON-RPC messages of an SSE body.
export function captureBody(text, { secrets = [], contentType = '' } = {}) {
  const raw = String(text ?? '');
  const bytes = Buffer.byteLength(raw);
  const truncated = bytes > MAX_BODY;
  const clean = scrub(truncated ? Buffer.from(raw).subarray(0, MAX_BODY).toString('utf8') : raw, secrets);
  const out = { bytes, truncated, tokens: estimateTokens(clean) };
  if (!clean) return out;
  if (/text\/event-stream/i.test(contentType)) { out.sse = sseMessages(clean); out.text = clean; return out; }
  try { out.json = JSON.parse(clean); } catch { out.text = clean; }
  return out;
}

// JSON-RPC method and id of a request body (a batch shows every method, comma separated).
export function rpcSummary(json) {
  if (Array.isArray(json)) return { rpcMethod: json.map((m) => String(m?.method ?? '?').slice(0, 60)).join(', ').slice(0, 200), rpcId: null };
  if (json && typeof json === 'object') return { rpcMethod: json.method === undefined ? null : String(json.method).slice(0, 100), rpcId: json.id ?? null };
  return { rpcMethod: null, rpcId: null };
}

// The list view leaves the bodies out; GET /api/proxy/flows/:id has the full record.
export const summary = ({ request, response, ...rest }) => ({
  ...rest,
  requestBytes: request?.body?.bytes ?? 0, responseBytes: response?.body?.bytes ?? 0,
  requestTokens: request?.body?.tokens ?? 0, responseTokens: response?.body?.tokens ?? 0,
});

export function createFlowLog({ max = MAX_FLOWS } = {}) {
  let seq = 0;
  const flows = [];
  return {
    add(rec) { const f = { id: ++seq, ...rec }; flows.push(f); while (flows.length > max) flows.shift(); return f; },
    list: ({ after = 0 } = {}) => flows.filter((f) => f.id > after),
    get: (id) => flows.find((f) => f.id === id) || null,
    clear() { flows.length = 0; },
    get size() { return flows.length; },
  };
}
