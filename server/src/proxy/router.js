// Live proxy: a local debugging passthrough you point an MCP client (Claude Code, Cursor, ...) at, so you can see what it
// really sends. One URL per target: http://127.0.0.1:<port>/proxy/mcp/<connection id>. Not a gateway: it enforces no
// policy, and the inspector's confirm gate does NOT apply to calls an agent makes through it (the agent decides).
//
// Safety (each has a test in proxy.test.js):
//  - off by default; the operator turns it on from this tool's own page, which mints a fresh random proxy token. Every
//    proxied request needs `Authorization: Bearer <that token>`. Turning it off (or Reset, or a restart) kills the token
//    and closes every stream still open. The token keeps out web pages and anything that has not read it from this
//    tool; it is NOT a barrier against programs already running as you on this machine (they can read it from
//    GET /api/proxy, as they can read the saved connections file itself).
//  - the app-wide loopback Host check still applies; a request that carries a browser Origin from another site is
//    refused (403), so a web page cannot drive it. No CORS headers are ever sent.
//  - the client's Authorization header is never forwarded upstream; the upstream credential is the saved connection's
//    own (write-only, as everywhere in this tool). Neither is stored in the flow log (see flows.js), and an upstream
//    that echoes the saved credential has it scrubbed from what the client receives too (rule 4).
//  - Mock mode (rule 19) offers the two built-in fixtures only, answered in this process; saved connections need Real.
//  - http targets: raw passthrough (bytes streamed, SSE included), redirects refused. stdio / PingOne / fixtures:
//    bridged (JSON-RPC answered through this tool's own client for that connection).
import crypto from 'node:crypto';
import express from 'express';
import { createMockClient, FIXTURES } from '../mock.js';
import { clip, scrub, scrubJson } from '../redact.js';
import { captureBody, createFlowLog, createStreamScrubber, keptHeaders, MAX_BODY, MAX_FLOWS, rpcSummary, summary } from './flows.js';
import { TOKEN_METHOD } from './tokens.js';

const TRANSPORTS = new Set(['http', 'stdio', 'pingone']);
const FIXTURE_IDS = Object.keys(FIXTURES).map((f) => `mock-${f}`);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createProxy({ store, manager, getMode, mockOnly, secretsFor, headerTimeoutMs = 30_000 }) {
  const flows = createFlowLog();
  const state = { enabled: false, token: null };
  const fixtureClients = new Map();
  const inflight = new Set(); // AbortControllers of passthrough requests still open

  const closeAll = () => { for (const ac of inflight) ac.abort(new Error('the proxy was turned off')); inflight.clear(); };
  function setEnabled(on) {
    state.enabled = Boolean(on);
    state.token = on ? crypto.randomBytes(24).toString('base64url') : null;
    if (!on) closeAll();
  }
  const tokenOk = (header) => {
    if (!state.token || typeof header !== 'string') return false;
    const a = Buffer.from(header); const b = Buffer.from(`Bearer ${state.token}`);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const realAllowed = () => !mockOnly && getMode() === 'real';

  function fixtureRoute(id) { const f = id.slice(5); return { id, label: FIXTURES[f].label, transport: 'mock', fixture: f }; }
  function routes() {
    const out = FIXTURE_IDS.map(fixtureRoute);
    if (realAllowed()) for (const c of store.list()) if (!FIXTURE_IDS.includes(c.id)) out.push({ id: c.id, label: c.label, transport: c.transport });
    return out.map((r) => ({ id: r.id, label: r.label, transport: r.transport, path: `/proxy/mcp/${encodeURIComponent(r.id)}` }));
  }
  // -> {kind:'fixture'|'conn', ...} or {status, error, message}
  function resolve(id) {
    if (FIXTURE_IDS.includes(id)) return { kind: 'fixture', route: fixtureRoute(id) };
    const conn = store.get(id);
    if (!conn || typeof conn !== 'object' || conn.id !== id || !TRANSPORTS.has(conn.transport)) return { status: 404, error: 'not_found', message: 'no such proxy route' };
    if (!realAllowed()) return { status: 409, error: 'mock_mode', message: mockOnly ? 'This copy is mock only: only the built-in sample servers can be proxied.' : 'Saved servers are proxied in Real mode only. Switch the header toggle to Real, or use a built-in sample route.' };
    return { kind: 'conn', conn };
  }

  // ---- the proxy itself (mounted at /proxy, outside /api: MCP clients send no Origin) --------------------------
  const proxy = express.Router();
  proxy.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try { same = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { same = false; }
      if (!same) return res.status(403).json({ error: 'cross_origin', message: 'The proxy does not answer web pages from other sites.' });
    }
    if (!state.enabled) return res.status(503).json({ error: 'proxy_off', message: 'The proxy is off. Turn it on from the Live proxy page of this tool.' });
    if (!tokenOk(req.headers.authorization)) return res.status(401).json({ error: 'proxy_token', message: 'Send Authorization: Bearer <proxy token> (shown on the Live proxy page; it changes each time the proxy is turned on).' });
    return next();
  });
  proxy.all('/mcp/:id', express.raw({ type: () => true, limit: '4mb' }), (req, res, next) => handle(req, res).catch(next));
  async function handle(req, res) {
    const target = resolve(req.params.id);
    if (target.status) return res.status(target.status).json({ error: target.error, message: target.message });
    const reqText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const secrets = [state.token, ...(target.conn ? secretsFor(target.conn) : [])];
    const reqBody = captureBody(reqText, { secrets, contentType: req.headers['content-type'] });
    const conn = target.conn;
    const flow = flows.add({
      at: new Date().toISOString(), route: req.params.id, routeLabel: clip(conn?.label ?? target.route?.label ?? req.params.id, 80),
      transport: conn?.transport ?? 'mock', via: conn?.transport === 'http' ? 'passthrough' : 'bridge',
      httpMethod: req.method, ...rpcSummary(reqBody.json), status: null, ms: null, open: true,
      request: { headers: keptHeaders(req.headers, { authLabel: '[proxy token, not forwarded]' }), body: reqBody },
      response: null, error: null,
    });
    const started = Date.now();
    const done = (status, response, error = null) => Object.assign(flow, { status, ms: Date.now() - started, open: false, response, error: error && clip(scrub(error, secrets)) });
    try {
      if (conn?.transport === 'http') await passthrough({ req, res, conn, reqText, secrets, flow, started, done });
      else await bridge({ req, res, target, reqText, secrets, done });
    } catch (err) {
      done(502, null, err.message);
      if (!res.headersSent) res.status(502).json({ error: 'upstream_error', message: clip(scrub(err.message, secrets)) });
      else res.end();
    }
  }
  proxy.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'proxy routes are /proxy/mcp/<id>' }));
  // JSON errors only (never Express's HTML page with a stack): a body over 4 MB, a parse failure, anything else.
  proxy.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'request body is larger than 4 MB' });
    console.error('[mcp-tools] proxy error:', err.code || err.name);
    return res.status(500).json({ error: 'server_error' });
  });

  async function passthrough({ req, res, conn, reqText, secrets, flow, started, done }) {
    const headers = {};
    for (const k of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) if (req.headers[k]) headers[k] = req.headers[k];
    if (conn.token) headers[conn.authHeader || 'Authorization'] = conn.token;
    const ac = new AbortController();
    inflight.add(ac);
    res.on('close', () => { ac.abort(); inflight.delete(ac); });
    const timer = setTimeout(() => ac.abort(new Error(`upstream sent no response headers in ${headerTimeoutMs / 1000}s`)), headerTimeoutMs);
    let up;
    try {
      up = await fetch(conn.url, { method: req.method, headers, body: req.method === 'POST' ? reqText : undefined, redirect: 'manual', signal: ac.signal });
    } catch (err) {
      const why = ac.signal.reason?.message || `upstream unreachable (${err?.cause?.code || err?.code || 'network error'})`;
      throw new Error(why);
    } finally { clearTimeout(timer); }
    if (up.status >= 300 && up.status < 400) { up.body?.cancel().catch(() => {}); throw new Error(`upstream HTTP ${up.status}: redirects are not followed`); }
    const out = {};
    for (const k of ['content-type', 'mcp-session-id', 'cache-control']) { const v = up.headers.get(k); if (v) out[k] = v; }
    res.status(up.status).set(out);
    if (up.status === 401) flow.error = 'upstream refused the saved credential (401); the proxy does not run OAuth for the client';
    flow.status = up.status; // visible while an SSE stream is still open
    flow.response = { headers: keptHeaders(up.headers), body: { bytes: 0, truncated: false, tokens: 0 } };
    // The client gets the upstream reply with every secret of this connection scrubbed out, streamed as it arrives.
    const scrubber = createStreamScrubber(secrets);
    const dec = new TextDecoder();
    let logged = ''; let bytes = 0;
    const emit = async (text) => {
      if (!text) return;
      if (logged.length < MAX_BODY) logged += text.slice(0, MAX_BODY - logged.length + 1);
      if (!res.write(text)) await new Promise((r) => { res.once('drain', r); res.once('close', r); }); // backpressure
    };
    const reader = up.body?.getReader();
    if (reader) {
      res.flushHeaders();
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          bytes += value.length;
          flow.response.body.bytes = bytes;
          await emit(scrubber.push(dec.decode(value, { stream: true })));
          if (res.destroyed) break;
        }
        await emit(scrubber.push(dec.decode()) + scrubber.end());
      } catch (err) { if (!ac.signal.aborted) throw err; } finally { reader.cancel().catch(() => {}); inflight.delete(ac); }
    }
    res.end();
    const body = captureBody(logged, { secrets, contentType: out['content-type'] });
    body.bytes = bytes; body.truncated = bytes > MAX_BODY;
    done(up.status, { headers: keptHeaders(up.headers), body }, flow.error);
  }

  function clientFor(target) {
    if (target.kind === 'fixture') {
      const f = target.route.fixture;
      if (!fixtureClients.has(f)) fixtureClients.set(f, createMockClient(f));
      return fixtureClients.get(f);
    }
    return manager.client(target.conn.id);
  }
  // JSON-RPC answered through this tool's own client for that connection (fixture, stdio or PingOne).
  async function bridge({ req, res, target, reqText, secrets, done }) {
    if (req.method === 'DELETE') { res.status(204).end(); return done(204, null); }
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST, DELETE').json({ error: 'method_not_allowed', message: 'This route is bridged: POST JSON-RPC only (no server-sent stream).' }); return done(405, null); }
    let msg = null; // the request as sent (the flow log holds a scrubbed, capped copy; never forward that)
    try { msg = JSON.parse(reqText); } catch { msg = null; }
    const reply = (status, payload) => {
      const text = JSON.stringify(scrubJson(payload, secrets)); // a bridged server's echo of a secret is scrubbed too
      res.status(status).type('application/json').send(text);
      done(status, { headers: { 'content-type': 'application/json' }, body: captureBody(text, { secrets, contentType: 'application/json' }) });
    };
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC 2.0 message per POST (batches are not supported on a bridged route)' } });
    if (msg.id === undefined) { res.status(202).end(); return done(202, null); } // a notification
    const client = clientFor(target);
    try {
      let result;
      if (msg.method === 'initialize') { await client.ensure(); const i = client.info() || {}; result = { protocolVersion: i.protocolVersion, capabilities: i.capabilities || {}, serverInfo: i.serverInfo || { name: 'bridged', version: '0' } }; }
      else if (msg.method === 'ping') result = {};
      else result = await client.rpc(msg.method, isObject(msg.params) ? msg.params : {});
      return reply(200, { jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      return reply(200, { jsonrpc: '2.0', id: msg.id, error: { code: Number.isInteger(err.mcpCode) ? err.mcpCode : -32603, message: clip(scrub(err.message, secrets)) } });
    }
  }

  // ---- the control API (mounted inside /api: same-origin writes apply) ---------------------------------------
  const api = express.Router();
  const view = () => ({ enabled: state.enabled, token: state.token, routes: routes(), tokenMethod: TOKEN_METHOD, maxFlows: MAX_FLOWS, maxBody: MAX_BODY });
  api.get('/', (_req, res) => res.set('Cache-Control', 'no-store').json(view()));
  api.post('/', express.json({ limit: '4kb' }), (req, res) => {
    const body = req.body ?? {};
    if (!isObject(body) || Object.keys(body).some((k) => k !== 'enabled') || typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'bad_request', message: 'the only accepted body is { "enabled": true | false }' });
    setEnabled(body.enabled);
    res.set('Cache-Control', 'no-store').json(view());
  });
  api.get('/flows', (req, res) => {
    const after = Number.parseInt(String(req.query.after ?? '0'), 10);
    res.set('Cache-Control', 'no-store').json({ flows: flows.list({ after: Number.isFinite(after) ? after : 0 }).map(summary) });
  });
  api.get('/flows/:id', (req, res) => {
    const f = flows.get(Number.parseInt(req.params.id, 10));
    if (!f) return res.status(404).json({ error: 'not_found', message: 'no such flow (the log keeps the last 200)' });
    res.set('Cache-Control', 'no-store').json({ flow: f });
  });
  api.delete('/flows', (_req, res) => { flows.clear(); res.status(204).end(); });

  return {
    proxy, api,
    reset() { setEnabled(false); flows.clear(); fixtureClients.clear(); },
  };
}
