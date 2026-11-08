// One Express app: the API under /api and the built web UI when web/dist exists. createApp() is what tests use.
//
// Safety rules enforced here (each has a test):
//  - every request: loopback Host check; every write: same-origin Origin check (security.js)
//  - tokens and stdio env values are never in any response, log line or error (store.js publicView, redact.js scrub)
//  - tools/call needs {confirm:true, argsHash}: the hash of the exact arguments the operator was shown (canonical.js)
//  - a scan reads metadata (and resource/prompt content); it never calls a tool and never changes the server's data
//  - stdio commands come only from a POST the operator made this session; they are never stored or read from disk
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { argsHash, canonicalJson } from './canonical.js';
import { dataDir, pingoneEnabled, port as configPort, scanMaxBytes } from './config.js';
import { createGatewayRouter } from './gateway/routes.js';
import { listKnownServers } from './knownServers.js';
import { createHealth } from './health.js';
import { createManager } from './mcp/manager.js';
import { PROTOCOL_METHODS } from './mcp/methods.js';
import { createMockStore, MOCK_REFUSAL, mockBodyAllowed, mockGuard, mockOnly } from './mock.js';
import { createPingone } from './pingone.js';
import { createFill } from './fill.js';
import { createFlagStore, FlagError } from './flags.js';
import { createOAuth, OAuthError } from './oauth.js';
import { PiFlowError } from './piflow.js';
import { createInputStore, InputError } from './inputs.js';
import { createProxy } from './proxy/router.js';
import { clip, scrub, scrubJson } from './redact.js';
import { analyze, buildReport, parseSnapshot, SnapshotError } from './scanner/index.js';
import { collectFromClient } from './scanner/live.js';
import { LIMITS, RULES } from './scanner/rules.js';
import { hostCheck, sameOriginWrites } from './security.js';
import { createStore } from './store.js';
import { shelfInfo } from './shelfLink.js';

const WEB_DIST = process.env.WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, message, status = 400, error = status === 404 ? 'not_found' : 'bad_request') => res.status(status).json({ error, message });
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createApp({ env = process.env, store = mockOnly(env) ? createMockStore() : createStore({ dir: dataDir(env) }), health = createHealth({ env }), pingone = pingoneEnabled(env) ? createPingone({ env, port: configPort(env) }) : null, knownServers = listKnownServers } = {}) {
  const mock = mockOnly(env);
  if (mock && store.file !== null) store = createMockStore(); // mock-only never uses a disk store
  const fill = createFill();
  const oauth = createOAuth({ env }); // OAuth sign-ins: pi.flow for our PingOne, browser redirect for third parties; tokens in memory only
  const manager = createManager({ store, pingone: mock ? null : pingone, mock, oauth });
  // Saved inputs live next to the connections file (memory only when the store is virtual).
  const inputs = createInputStore({ dir: store.file ? path.dirname(store.file) : null, connectionExists: (id) => Boolean(store.get(id)) });
  const flags = createFlagStore({ dir: store.file ? path.dirname(store.file) : null, connectionExists: (id) => Boolean(store.get(id)) });
  const maxScan = scanMaxBytes(env);
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck(env));
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    });
    next();
  });

  const api = express.Router();
  const small = express.json({ limit: '256kb' });
  const big = express.json({ limit: maxScan });
  api.use(sameOriginWrites());
  if (mock) api.use(mockGuard());
  api.use('/health', health.router);
  api.use('/gateway', createGatewayRouter({ getMode: () => mode, mockOnly: mock, env })); // Mock: the in-process simulation, no outbound call. Real: gateway/real.js

  // Text from a failing server or transport, with this connection's secrets removed.
  const fail = (res, err, conn, status = 502) => {
    const secrets = secretsFor(conn);
    res.status(err.code === 'pingone_login_required' || err.code === 'mcp_signin_needed' ? 401 : status).json({ error: err.code || 'upstream_error', message: clip(scrub(err.message, secrets)) });
  };
  // A success body that came from a server: this connection's secrets are removed if the server echoed them back.
  const secretsFor = (conn) => [...store.secretsOf(conn), ...(pingone?.secrets() || []), ...(conn?.id ? oauth.secrets(conn.id) : [])];
  const send = (res, conn, payload) => res.json(scrubJson(payload, secretsFor(conn)));
  const connection = (req, res) => {
    const conn = store.get(req.params.id);
    if (!conn) bad(res, 'no such connection', 404);
    return conn;
  };

  // The MCP servers this family runs here, and whether each is running right now (a TCP connect to a loopback port). The hosted
  // mock has none: it accepts only its built-in samples.
  api.get('/known-servers', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ servers: mock ? [] : await knownServers() });
  });
  api.get('/config', (_req, res) => res.json({
    scanMaxBytes: maxScan, stdio: !mock, mockOnly: mock,
    pingone: pingone && !mock ? pingone.status() : { enabled: false },
  }));
  // Rule 19: the Mock/Real toggle. The mode is server-side and runtime-switchable. Real (the live inspector)
  // is refused on a MOCK_ONLY=1 hosted copy with 409 and the honest reason; elsewhere it is always available.
  const modeView = () => ({
    source: mode === 'real' ? 'real' : 'mock',
    realAvailable: !mock,
    ...(mock ? { realReason: 'This hosted copy is mock only (MOCK_ONLY=1): every server is an in-process fixture and nothing can connect out, so Real is unavailable.' } : { realReason: null }),
  });
  let mode = 'mock';
  // Live proxy (Peek-style flow log). Its control API is under /api/proxy; the proxy itself is /proxy/mcp/<id> (below).
  const liveProxy = createProxy({ store, manager, getMode: () => mode, mockOnly: mock, secretsFor, oauth });
  api.use('/proxy', liveProxy.api);
  api.get('/info', (_req, res) => res.set('Cache-Control', 'no-store').json(modeView()));
  api.post('/mode', small, (req, res) => {
    const body = req.body ?? {};
    if (!isObject(body) || Object.keys(body).some((k) => k !== 'source')) return bad(res, 'the only accepted body field is { "source": "mock" | "real" }.');
    if (body.source !== 'mock' && body.source !== 'real') return bad(res, 'source must be "mock" or "real".');
    if (body.source === 'real' && mock) return res.status(409).json({ error: 'real_not_available', message: 'Real is not available: this hosted copy is mock only (MOCK_ONLY=1). Every server here is an in-process fixture; set up your own copy without MOCK_ONLY to inspect real servers.', source: 'mock' });
    const next = body.source === 'real' ? 'real' : 'mock';
    if (next !== mode) liveProxy.modeChanged(); // rule 19: the proxy's log and open streams belong to the old mode
    mode = next;
    res.json(modeView());
  });
  api.get('/rules', (_req, res) => res.json({ rules: Object.entries(RULES).map(([id, r]) => ({ id, ...r })), limits: LIMITS }));
  api.get('/protocol-methods', (_req, res) => res.json({ methods: PROTOCOL_METHODS }));

  // ---- connections -------------------------------------------------------
  api.get('/connections', (_req, res) => res.json({ connections: store.list().map(store.publicView) }));

  async function testConnection(conn) {
    try {
      const info = await manager.test(conn.id);
      return {
        ok: true, protocolVersion: clip(info.protocolVersion, 40),
        serverInfo: info.serverInfo ? { name: clip(info.serverInfo.name, 80), version: clip(info.serverInfo.version, 40) } : null,
        capabilities: Object.keys(info.capabilities || {}).slice(0, 20).map((k) => clip(k, 40)),
      };
    } catch (err) {
      return { ok: false, error: clip(scrub(err.message, secretsFor(conn))) };
    }
  }
  api.post('/connections', small, wrap(async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    if (mock && !mockBodyAllowed(body)) return res.status(403).json(MOCK_REFUSAL); // url, token, command, env, pingone: all refused
    if (body.transport === 'pingone' && !pingone) return bad(res, 'PingOne is off. Set MCPTOOLS_PINGONE=1 (optional, untested here).', 400, 'pingone_disabled');
    let conn;
    try { conn = store.create(body); } catch (err) { return bad(res, err.message); }
    const test = await testConnection(conn);
    res.status(201).json({ connection: store.publicView(conn), test });
  }));
  api.post('/connections/:id/test', wrap(async (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    res.json({ test: await testConnection(conn) });
  }));
  api.delete('/connections/:id', wrap(async (req, res) => {
    if (!(await manager.remove(req.params.id))) return bad(res, 'no such connection', 404);
    inputs.removeFor(req.params.id);
    oauth.signOut(req.params.id, { forget: true });
    flags.removeFor(req.params.id);
    liveProxy.closeRoute(req.params.id);
    res.status(204).end();
  }));

  // Reset (rule 3): clears every saved connection in this instance's store. Mock stores
  // are virtual, so the answer there is honest ("nothing stored").
  // Reset (rule 3): POST /api/reset clears every saved connection in this instance's store.
  api.post('/reset', wrap(async (_req, res) => {
    liveProxy.reset(); // proxy off, its token gone, flow log cleared
    inputs.clear();
    oauth.clear();
    flags.clear();
    if (store.file === null) return res.json({ ok: true, cleared: 0, note: 'mock-only: nothing is stored' });
    const ids = store.list().map((c) => c.id);
    for (const id of ids) await manager.remove(id);
    res.json({ ok: true, cleared: ids.length, note: 'saved connections removed' });
  }));

  // ---- saved inputs: named argument sets per tool. Loading one fills the call form; the confirm gate still applies.
  api.get('/connections/:id/inputs', (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    if (req.query.tool !== undefined && typeof req.query.tool !== 'string') return bad(res, 'tool must be one tool name');
    const tool = req.query.tool;
    res.set('Cache-Control', 'no-store').json({ inputs: inputs.list(conn.id, tool) });
  });
  api.post('/connections/:id/inputs', small, (req, res) => {
    if (mock) return res.status(403).json(MOCK_REFUSAL); // a shared mock copy keeps nothing one visitor could see from another
    const conn = connection(req, res); if (!conn) return;
    const body = isObject(req.body) ? req.body : {};
    if (Object.keys(body).some((k) => !['tool', 'name', 'arguments', 'source'].includes(k))) return bad(res, 'accepted fields: tool, name, arguments, source');
    try { res.status(201).json({ input: inputs.create(conn.id, body) }); } catch (err) { if (err instanceof InputError) return bad(res, err.message); throw err; }
  });
  api.delete('/connections/:id/inputs/:inputId', (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    if (!inputs.remove(conn.id, req.params.inputId)) return bad(res, 'no such saved input', 404);
    res.status(204).end();
  });

  // ---- flags: a note on a tool, resource or prompt, for the Markdown review brief (built in the page) ----
  api.get('/connections/:id/flags', (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    res.set('Cache-Control', 'no-store').json({ flags: flags.list(conn.id) });
  });
  api.put('/connections/:id/flags', small, (req, res) => {
    if (mock) return res.status(403).json(MOCK_REFUSAL);
    const conn = connection(req, res); if (!conn) return;
    const body = isObject(req.body) ? req.body : {};
    if (Object.keys(body).some((k) => !['kind', 'name', 'note'].includes(k))) return bad(res, 'accepted fields: kind, name, note');
    try { res.json({ flag: flags.put(conn.id, body) }); } catch (err) { if (err instanceof FlagError) return bad(res, err.message); throw err; }
  });
  api.delete('/connections/:id/flags/:flagId', (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    if (!flags.remove(conn.id, req.params.flagId)) return bad(res, 'no such flag', 404);
    res.status(204).end();
  });

  // A signed-in OAuth token that is about to expire is refreshed before any route that talks to that server.
  api.use('/connections/:id', (req, _res, next) => { oauth.fresh(req.params.id).then(() => next(), next); });

  // What the call form may fill in: our demo values for this server and who is signed in (claims, never the token).
  api.get('/connections/:id/fill', (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const identity = conn.transport === 'pingone' ? pingone?.identity?.() ?? null : oauth.identity(conn.id);
    res.set('Cache-Control', 'no-store').json({ demo: mock ? {} : fill.demoFor(conn), identity });
  });

  // ---- OAuth sign-in for a third-party server (rule-16 exception; Ping hosts refused) -------------------------
  const oauthConn = (req, res) => {
    if (mock) { res.status(403).json(MOCK_REFUSAL); return null; }
    const conn = connection(req, res); if (!conn) return null;
    if (conn.transport !== 'http') { bad(res, 'OAuth sign-in is for http connections', 400, 'oauth_not_http'); return null; }
    return conn;
  };
  const oauthFail = (res, err, conn) => {
    if (err instanceof OAuthError) return res.status(err.code === 'oauth_unreachable' ? 502 : 400).json({ error: err.code, message: clip(scrub(err.message, secretsFor(conn))) });
    throw err;
  };
  api.get('/connections/:id/oauth', wrap(async (req, res) => {
    const conn = oauthConn(req, res); if (!conn) return;
    try {
      const d = await oauth.discover(conn);
      res.set('Cache-Control', 'no-store').json({ ...oauth.status(conn.id), required: d.required, method: d.method ?? null, issuer: d.issuer ?? oauth.status(conn.id).issuer, scopes: d.scopes ?? [], dynamicRegistration: Boolean(d.registrationEndpoint), refused: d.refused ?? null, redirectUri: `http://${req.headers.host}/api/oauth/callback` });
    } catch (err) { oauthFail(res, err, conn); }
  }));
  api.post('/connections/:id/oauth/start', small, wrap(async (req, res) => {
    const conn = oauthConn(req, res); if (!conn) return;
    const body = isObject(req.body) ? req.body : {};
    if (Object.keys(body).some((k) => k !== 'clientId') || (body.clientId !== undefined && (typeof body.clientId !== 'string' || body.clientId.length > 200))) return bad(res, 'the only accepted field is clientId (a string)');
    try { res.json(await oauth.start(conn, { clientId: body.clientId, redirectUri: `http://${req.headers.host}/api/oauth/callback` })); } catch (err) { oauthFail(res, err, conn); }
  }));
  // pi.flow (our PingOne): start returns an opaque run handle; the password goes to this tool only, once, never stored.
  const piflowFail = (res, err, conn) => {
    if (err instanceof PiFlowError) return res.status(err.status).json({ error: err.code, message: clip(scrub(err.message, secretsFor(conn))) });
    return oauthFail(res, err, conn);
  };
  api.post('/connections/:id/oauth/piflow', small, wrap(async (req, res) => {
    const conn = oauthConn(req, res); if (!conn) return;
    try { res.json(await oauth.piflowStart(conn, { redirectUri: `http://${req.headers.host}/api/oauth/callback` })); } catch (err) { piflowFail(res, err, conn); }
  }));
  api.post('/connections/:id/oauth/piflow/credentials', small, wrap(async (req, res) => {
    const conn = oauthConn(req, res); if (!conn) return;
    const body = isObject(req.body) ? req.body : {};
    if (Object.keys(body).some((k) => !['run', 'username', 'password'].includes(k))) return bad(res, 'accepted fields: run, username, password');
    try { res.json(await oauth.piflowCredentials(conn.id, body.run, body)); } catch (err) { piflowFail(res, err, conn); }
  }));
  api.post('/connections/:id/oauth/signout', (req, res) => {
    const conn = oauthConn(req, res); if (!conn) return;
    oauth.signOut(conn.id);
    res.json(oauth.status(conn.id));
  });
  // The authorization server sends the browser here (a GET with no Origin): the single-use state is what binds it.
  const page = (title, text) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p></body></html>`;
  api.get('/oauth/callback', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const q = Object.fromEntries(Object.entries(req.query).filter(([k, v]) => typeof v === 'string' || (k === 'iss' && Array.isArray(v))));
    if (mock) return res.status(403).type('html').send(page('Not available', 'This copy is mock only.'));
    try {
      await oauth.callback(q);
      res.type('html').send(page('Signed in', 'Signed in. Close this tab and go back to MCP tools: the Server page picks the sign-in up.'));
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      res.status(400).type('html').send(page('Sign-in failed', clip(err.message, 200)));
    }
  }));

  // ---- see: list ---------------------------------------------------------
  api.get('/connections/:id/tools', wrap(async (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const started = Date.now();
    try {
      const { tools, notes } = await collectFromClient(manager.client(conn.id), { fetchContent: false });
      send(res, conn, { tools, notes, durationMs: Date.now() - started });
    } catch (err) { fail(res, err, conn); }
  }));

  // ---- judge: scan -------------------------------------------------------
  const trustedList = (v) => (Array.isArray(v) ? v.map((s) => clip(s, 200)).filter(Boolean).slice(0, 500) : []);
  api.post('/connections/:id/scan', small, wrap(async (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const body = isObject(req.body) ? req.body : {};
    const trustedNames = trustedList(body.trustedNames);
    try {
      const got = await collectFromClient(manager.client(conn.id), { fetchContent: body.fetchContent !== false });
      const { findings, truncated } = analyze(got, { trustedNames });
      const report = buildReport({ findings, truncated, input: got, source: { type: 'connection', label: conn.label }, trustedNames });
      const secrets = secretsFor(conn);
      report.notes = got.notes.map((n) => clip(scrub(n, secrets)));
      send(res, conn, {
        report,
        listed: {
          tools: got.tools.map((t) => ({ name: t?.name, description: t?.description, inputSchema: t?.inputSchema, ...(t?.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations) ? { annotations: { readOnlyHint: t.annotations.readOnlyHint === true ? true : t.annotations.readOnlyHint === false ? false : undefined, destructiveHint: t.annotations.destructiveHint === true ? true : undefined } } : {}) })),
          resources: got.resources.map((r) => ({ uri: r?.uri, name: r?.name, description: r?.description })),
          prompts: got.prompts.map((p) => ({ name: p?.name, description: p?.description, arguments: p?.arguments })),
        },
      });
    } catch (err) { fail(res, err, conn); }
  }));
  // Offline: a pasted or loaded snapshot, no server involved.
  api.post('/scan', big, wrap(async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    if (body.snapshot === undefined) return bad(res, 'body must be {snapshot, trustedNames?}');
    try {
      const input = parseSnapshot(body.snapshot, { maxBytes: maxScan });
      const trustedNames = trustedList(body.trustedNames);
      const { findings, truncated } = analyze(input, { trustedNames });
      res.json({ report: buildReport({ findings, truncated, input, source: { type: 'snapshot', label: 'pasted snapshot' }, trustedNames }) });
    } catch (err) {
      if (err instanceof SnapshotError) return bad(res, err.message, err.status, err.code);
      throw err;
    }
  }));

  // ---- act: confirm-gated calls -----------------------------------------
  // The confirm contract. 1) preview returns the canonical arguments and their hash; the UI shows exactly that text.
  // 2) the call must send {confirm:true, argsHash}; a missing confirm is 428, a hash that does not match the
  // arguments actually sent is 409. Nothing is sent to the server before both pass.
  function gate(req, res, { method, name, args }) {
    const expected = argsHash({ connectionId: req.params.id, method, name, args });
    if (req.body?.confirm !== true) { bad(res, 'confirm is required: show the exact arguments and send {confirm:true, argsHash}', 428, 'confirm_required'); return null; }
    if (req.body?.argsHash !== expected) { bad(res, 'argsHash does not match the arguments sent; preview again', 409, 'args_changed'); return null; }
    return expected;
  }
  api.post('/connections/:id/call/preview', small, (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const { tool, arguments: args = {} } = isObject(req.body) ? req.body : {};
    if (typeof tool !== 'string' || !tool) return bad(res, 'tool name is required');
    if (!isObject(args)) return bad(res, 'arguments must be a JSON object');
    res.json({ method: 'tools/call', tool, canonical: canonicalJson({ name: tool, arguments: args }), argsHash: argsHash({ connectionId: conn.id, method: 'tools/call', name: tool, args }) });
  });
  api.post('/connections/:id/call', small, wrap(async (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const { tool, arguments: args = {} } = isObject(req.body) ? req.body : {};
    if (typeof tool !== 'string' || !tool) return bad(res, 'tool name is required');
    if (!isObject(args)) return bad(res, 'arguments must be a JSON object');
    if (!gate(req, res, { method: 'tools/call', name: tool, args })) return;
    const started = Date.now();
    try { send(res, conn, { result: await manager.rpc(conn.id, 'tools/call', { name: tool, arguments: args }), durationMs: Date.now() - started }); }
    catch (err) { fail(res, err, conn); }
  }));
  api.post('/connections/:id/rpc/preview', small, (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const { method, params = {} } = isObject(req.body) ? req.body : {};
    if (!PROTOCOL_METHODS.some((m) => m.method === method)) return bad(res, 'unknown method', 400, 'invalid_method');
    if (!isObject(params)) return bad(res, 'params must be a JSON object');
    res.json({ method, canonical: canonicalJson({ method, params }), argsHash: argsHash({ connectionId: conn.id, method, name: '', args: params }) });
  });
  // The other protocol methods (resources, prompts, completion, logging). logging/setLevel changes server state, so it is gated too.
  api.post('/connections/:id/rpc', small, wrap(async (req, res) => {
    const conn = connection(req, res); if (!conn) return;
    const { method, params = {} } = isObject(req.body) ? req.body : {};
    const def = PROTOCOL_METHODS.find((m) => m.method === method);
    if (!def) return bad(res, `method must be one of: ${PROTOCOL_METHODS.map((m) => m.method).join(', ')}`, 400, 'invalid_method');
    if (!isObject(params)) return bad(res, 'params must be a JSON object');
    if (def.confirm && !gate(req, res, { method, name: '', args: params })) return;
    const started = Date.now();
    try { send(res, conn, { result: await manager.rpc(conn.id, method, params), durationMs: Date.now() - started }); }
    catch (err) { fail(res, err, conn); }
  }));

  // ---- optional PingOne (off unless MCPTOOLS_PINGONE=1) -------------------
  if (pingone && !mock) {
    api.get('/pingone/status', (_req, res) => res.json(pingone.status()));
    api.post('/pingone/login', wrap(async (_req, res) => {
      if (!pingone.configured()) return bad(res, 'Set PINGONE_ENVIRONMENT_ID and PINGONE_MCP_CLIENT_ID in ~/Development/.env first.', 400, 'pingone_not_configured');
      try { res.json(await pingone.startLogin()); } catch (err) { if (err instanceof PiFlowError) return res.status(err.status).json({ error: err.code, message: clip(err.message) }); throw err; }
    }));
    api.post('/pingone/credentials', small, wrap(async (req, res) => {
      const body = isObject(req.body) ? req.body : {};
      if (Object.keys(body).some((k) => !['run', 'username', 'password'].includes(k))) return bad(res, 'accepted fields: run, username, password');
      try { res.json(await pingone.credentials(body.run, body)); } catch (err) { if (err instanceof PiFlowError) return res.status(err.status).json({ error: err.code, message: clip(scrub(err.message, pingone.secrets())) }); throw err; }
    }));
    api.post('/pingone/signout', (_req, res) => { pingone.signOut(); res.json(pingone.status()); });
  }

  api.use((_req, res) => bad(res, 'no such endpoint', 404));
  api.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'request body is too large' });
    if (err.type === 'entity.parse.failed') return bad(res, 'request body is not valid JSON');
    console.error('[mcp-tools] api error:', err.code || err.name);
    return res.status(500).json({ error: 'server_error' });
  });
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
  app.use('/api', api);
  app.use('/proxy', liveProxy.proxy); // MCP clients send no Origin: the proxy has its own guards (proxy/router.js)

  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  app.locals.manager = manager;
  app.locals.oauth = oauth; // tests read what the sign-in store holds
  return app;
}
