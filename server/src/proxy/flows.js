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

// Each secret as sent and as it appears inside a JSON string (a `"` or `\` in it is escaped there).
export function secretVariants(secrets) {
  const out = new Set();
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) { out.add(s); out.add(JSON.stringify(s).slice(1, -1)); }
  return [...out];
}

// Scrubs a stream of text chunks: a secret split across two chunks is still caught, because the end of a chunk that
// could be the start of a secret is held back until the next chunk (or the end) shows what follows. Text that cannot
// start a secret is passed on at once, so an open SSE stream is not delayed.
export function createStreamScrubber(secrets) {
  const list = secretVariants(secrets);
  let held = '';
  const holdLen = (text) => {
    let best = 0;
    for (const sec of list) for (let k = Math.min(sec.length - 1, text.length); k > best; k -= 1) if (text.endsWith(sec.slice(0, k))) { best = k; break; }
    return best;
  };
  return {
    push(chunk) { const t = scrub(held + chunk, list); const k = holdLen(t); held = t.slice(t.length - k); return t.slice(0, t.length - k); },
    end() { const t = held; held = ''; return t; }, // a strict prefix of a secret is not the secret
  };
}

// A captured body: the text (scrubbed, then capped), the parsed JSON when it parses, or the JSON-RPC messages of an SSE
// body. Scrubbing comes first so a secret that straddles the cap is not left half in the log.
export function captureBody(text, { secrets = [], contentType = '' } = {}) {
  const scrubbed = scrub(String(text ?? ''), secretVariants(secrets));
  const bytes = Buffer.byteLength(String(text ?? ''));
  const truncated = Buffer.byteLength(scrubbed) > MAX_BODY;
  const clean = truncated ? Buffer.from(scrubbed).subarray(0, MAX_BODY).toString('utf8') : scrubbed;
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
