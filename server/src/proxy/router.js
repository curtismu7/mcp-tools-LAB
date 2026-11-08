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
//  - One URL for all: /proxy/mcp/ merges the tools of every route offered in this mode, named <alias>__<tool>, and
//    routes a call to the right server (tools only; resources and prompts stay on the per-server URLs). A server that
//    cannot be reached is reported in the listing's _meta, never silently dropped.
//  - Mock mode (rule 19) offers the two built-in fixtures only, answered in this process; saved connections need Real.
//  - http targets: raw passthrough (bytes streamed, SSE included), redirects refused. stdio / PingOne / fixtures:
//    bridged (JSON-RPC answered through this tool's own client for that connection). A stdio route also streams: a GET
//    opens server-sent events carrying what the server sends on its own (progress, logs, list_changed, its requests
//    to the client), and the client's answers to those requests are POSTed back and written to the server as sent.
import crypto from 'node:crypto';
import express from 'express';
import { createMockClient, FIXTURES } from '../mock.js';
import { clip, scrub, scrubJson } from '../redact.js';
import { captureBody, createFlowLog, createStreamScrubber, keptHeaders, MAX_BODY, MAX_FLOWS, rpcSummary, summary } from './flows.js';
import { TOKEN_METHOD } from './tokens.js';

const TRANSPORTS = new Set(['http', 'stdio', 'pingone']);
const FIXTURE_IDS = Object.keys(FIXTURES).map((f) => `mock-${f}`);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createProxy({ store, manager, getMode, mockOnly, secretsFor, oauth = null, headerTimeoutMs = 30_000 }) {
  const flows = createFlowLog();
  const state = { enabled: false, token: null };
  const fixtureClients = new Map();
  const inflight = new Set(); // AbortControllers of passthrough requests still open

  const closeAll = () => { for (const ac of inflight) ac.abort(new Error('the proxy was turned off')); inflight.clear(); };
  // A deleted connection: its open streams end, and anything the proxy kept for it is dropped.
  const closeRoute = (id) => { for (const ac of [...inflight]) if (ac.route === id) { ac.abort(new Error('the connection was removed')); inflight.delete(ac); } serverAsked.delete(id); };
  const serverAsked = new Map(); // route -> ids of requests the stdio server sent on its own (only these may be answered)
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
    // A saved 'mock' connection is one of the samples, already offered above: listed once, not twice.
    if (realAllowed()) for (const c of store.list()) if (!FIXTURE_IDS.includes(c.id) && TRANSPORTS.has(c.transport)) out.push({ id: c.id, label: c.label, transport: c.transport });
    return out.map((r) => ({ id: r.id, label: r.label, transport: r.transport, path: `/proxy/mcp/${encodeURIComponent(r.id)}` }));
  }
  // Aliases for the one-URL route: a slug of the label, made unique in order (sample, sample-2, ...).
  function members() {
    const used = new Set();
    return routes().map((r) => {
      const base = String(r.label || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'server';
      let alias = base; let n = 2;
      while (used.has(alias)) alias = `${base}-${n++}`;
      used.add(alias);
      return { ...r, alias };
    });
  }
  const ALL = { id: '*', label: 'All servers (one URL)', transport: 'aggregate', path: '/proxy/mcp/' };
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
  proxy.all('/mcp', express.raw({ type: () => true, limit: '4mb' }), (req, res, next) => aggregate(req, res).catch(next));
  async function handle(req, res) {
    const target = resolve(req.params.id);
    if (target.status) return res.status(target.status).json({ error: target.error, message: target.message });
    const reqText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (target.conn) await oauth?.fresh(target.conn.id); // a refresh mints a new token: it must be in `secrets` before anything is logged
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
    // (handle() already refreshed, before it collected the secrets to scrub: a second refresh here would mint a token it never saw.)
    const signedIn = oauth?.auth(conn.id); // a third-party OAuth sign-in wins over a saved token
    if (signedIn) headers[signedIn[0]] = signedIn[1];
    else if (conn.token) headers[conn.authHeader || 'Authorization'] = conn.token;
    const ac = new AbortController();
    ac.route = conn.id;
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
    if (up.status === 401) flow.error = 'upstream refused the credential (401): sign in on the Server page (OAuth) or save the server with a token';
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
    const client = clientFor(target);
    const streams = typeof client.subscribe === 'function'; // stdio
    if (req.method === 'GET' && streams) return stream({ req, res, target, client, secrets, done });
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST, DELETE').json({ error: 'method_not_allowed', message: 'This route is bridged: POST JSON-RPC only (no server-sent stream for this transport).' }); return done(405, null); }
    let msg = null; // the request as sent (the flow log holds a scrubbed, capped copy; never forward that)
    try { msg = JSON.parse(reqText); } catch { msg = null; }
    const reply = (status, payload) => {
      const text = JSON.stringify(scrubJson(payload, secrets)); // a bridged server's echo of a secret is scrubbed too
      res.status(status).type('application/json').send(text);
      done(status, { headers: { 'content-type': 'application/json' }, body: captureBody(text, { secrets, contentType: 'application/json' }) });
    };
    // A client's answer to a request the stdio server sent on its own: only an id the server really issued, and only
    // the JSON-RPC fields of a response (nothing else the client put in the body reaches the server).
    if (streams && isObject(msg) && msg.jsonrpc === '2.0' && msg.method === undefined && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      const asked = serverAsked.get(req.params.id);
      if (!asked?.has(msg.id)) return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'no such request from the server: only answers to requests the server sent are forwarded' } });
      asked.delete(msg.id);
      await client.send({ jsonrpc: '2.0', id: msg.id, ...('result' in msg ? { result: msg.result } : { error: msg.error }) });
      res.status(202).end(); return done(202, null);
    }
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC 2.0 message per POST (batches are not supported on a bridged route)' } });
    if (msg.id === undefined) { // a notification: stdio gets it (this tool already sent its own initialized)
      if (streams && !/^notifications\//.test(msg.method)) return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'only notifications/* may be sent without an id' } });
      if (streams && msg.method !== 'notifications/initialized') await client.send({ jsonrpc: '2.0', method: msg.method, ...(isObject(msg.params) ? { params: msg.params } : {}) });
      res.status(202).end(); return done(202, null);
    }
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

  // One URL for all servers: JSON-RPC answered here, tools fanned out to every member through this tool's own clients.
  async function aggregate(req, res) {
    const list = members();
    const targets = list.map((m) => ({ m, target: resolve(m.id) })).filter((x) => !x.target.status);
    await Promise.all(targets.map((x) => (x.target.conn ? oauth?.fresh(x.target.conn.id) : null)));
    const secrets = [state.token, ...targets.flatMap((x) => (x.target.conn ? secretsFor(x.target.conn) : []))];
    const reqText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const reqBody = captureBody(reqText, { secrets, contentType: req.headers['content-type'] });
    const flow = flows.add({
      at: new Date().toISOString(), route: ALL.id, routeLabel: ALL.label, transport: 'aggregate', via: 'aggregate',
      httpMethod: req.method, ...rpcSummary(reqBody.json), status: null, ms: null, open: true,
      request: { headers: keptHeaders(req.headers, { authLabel: '[proxy token, not forwarded]' }), body: reqBody }, response: null, error: null,
    });
    const started = Date.now();
    const done = (status, response, error = null) => Object.assign(flow, { status, ms: Date.now() - started, open: false, response, error: error && clip(scrub(error, secrets)) });
    const reply = (status, payload) => {
      const text = JSON.stringify(scrubJson(payload, secrets));
      res.status(status).type('application/json').send(text);
      done(status, { headers: { 'content-type': 'application/json' }, body: captureBody(text, { secrets, contentType: 'application/json' }) });
    };
    if (req.method === 'DELETE') { res.status(204).end(); return done(204, null); }
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST, DELETE').json({ error: 'method_not_allowed', message: 'The one-URL route answers POST JSON-RPC only.' }); return done(405, null); }
    let msg = null;
    try { msg = JSON.parse(reqText); } catch { msg = null; }
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC 2.0 message per POST' } });
    if (msg.id === undefined) { res.status(202).end(); return done(202, null); }
    const ok = (result) => reply(200, { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => reply(200, { jsonrpc: '2.0', id: msg.id, error: { code, message: clip(scrub(message, secrets)) } });
    if (msg.method === 'initialize') return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mcp-tools-all-servers', version: '1' }, instructions: `Tools of ${targets.length} server(s), named <server>__<tool>.` });
    if (msg.method === 'ping') return ok({});
    if (msg.method === 'tools/list') {
      const tools = []; const unreachable = [];
      await Promise.all(targets.map(async ({ m, target }) => {
        try {
          let cursor; let pages = 0; const got = [];
          do {
            const r = await clientFor(target).rpc('tools/list', cursor ? { cursor } : {});
            got.push(...(Array.isArray(r?.tools) ? r.tools : []));
            cursor = typeof r?.nextCursor === 'string' ? r.nextCursor : undefined;
          } while (cursor && ++pages < 20);
          for (const t of got) if (t && typeof t.name === 'string') tools.push({ ...t, name: `${m.alias}__${t.name}` });
        } catch (err) { unreachable.push({ server: m.alias, label: m.label, error: clip(err.message, 200) }); }
      }));
      tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (unreachable.length) flow.error = `unreachable: ${unreachable.map((u) => u.server).join(', ')}`;
      return ok({ tools, ...(unreachable.length ? { _meta: { 'mcp-tools/unreachable': unreachable } } : {}) });
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const cut = name.indexOf('__');
      const hit = cut > 0 ? targets.find((x) => x.m.alias === name.slice(0, cut)) : null;
      if (!hit) return fail(-32602, `no tool ${name.slice(0, 120)}: names are <server>__<tool>`);
      Object.assign(flow, { route: hit.m.id, routeLabel: clip(`${ALL.label} → ${hit.m.label}`, 80) }); // so Save as input finds the server
      try { return ok(await clientFor(hit.target).rpc('tools/call', { ...(isObject(msg.params) ? msg.params : {}), name: name.slice(cut + 2) })); }
      catch (err) { return fail(Number.isInteger(err.mcpCode) ? err.mcpCode : -32603, err.message); }
    }
    if (msg.method === 'resources/list' || msg.method === 'prompts/list') return ok(msg.method === 'resources/list' ? { resources: [] } : { prompts: [] });
    return fail(-32601, `${msg.method.slice(0, 80)} is not offered on the one-URL route; use the per-server URL`);
  }

  // The stdio stream: one SSE event per message the server sends on its own, each also logged as its own flow.
  async function stream({ req, res, target, client, secrets, done }) {
    await client.ensure();
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.flushHeaders();
    res.write(': stream open\n\n');
    done(200, { headers: { 'content-type': 'text/event-stream' }, body: { bytes: 0, truncated: false, tokens: 0 } });
    const label = clip(target.conn?.label ?? req.params.id, 80);
    const unsubscribe = client.subscribe((raw) => {
      if (raw.method && raw.id !== undefined) { if (!serverAsked.has(req.params.id)) serverAsked.set(req.params.id, new Set()); const s = serverAsked.get(req.params.id); if (s.size < 100) s.add(raw.id); } // a request the client may answer
      const msg = scrubJson(raw, secrets);
      const text = JSON.stringify(msg);
      res.write(`event: message\ndata: ${text}\n\n`);
      flows.add({
        at: new Date().toISOString(), route: req.params.id, routeLabel: label, transport: target.conn?.transport ?? 'stdio', via: 'stream',
        httpMethod: 'SSE', ...rpcSummary(msg), status: 200, ms: 0, open: false,
        request: { headers: {}, body: { bytes: 0, truncated: false, tokens: 0 } },
        response: { headers: { 'content-type': 'text/event-stream' }, body: captureBody(text, { secrets, contentType: 'application/json' }) }, error: null,
      });
    });
    const handle = { route: req.params.id, abort() { unsubscribe(); res.end(); } };
    inflight.add(handle);
    res.on('close', () => { unsubscribe(); inflight.delete(handle); });
  }

  // ---- the control API (mounted inside /api: same-origin writes apply) ---------------------------------------
  const api = express.Router();
  const view = () => ({ enabled: state.enabled, token: state.token, all: ALL, routes: routes(), tokenMethod: TOKEN_METHOD, maxFlows: MAX_FLOWS, maxBody: MAX_BODY });
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
    // A Mock/Real switch: the flow log is emptied and open streams are closed; the proxy stays on with the same token.
    modeChanged() { closeAll(); flows.clear(); },
    closeRoute,
  };
}
