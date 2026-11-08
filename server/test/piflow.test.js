// pi.flow sign-in with our PingOne (rule 16): a fake PingOne (flows API, cookies, resume, token) and a protected MCP
// server on loopback. MCPTOOLS_P1_ISSUER points the app at the fake; it only ever selects pi.flow.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { afterEach } from 'node:test';
import { startApp } from './helpers.js';

const T = { timeout: 20_000 };
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))); });
const listen = (h) => new Promise((r) => { const s = http.createServer(h); servers.push(s); s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)); });
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PASSWORD = 'Pa55-word-never-logged';

async function fakeP1({ identifierFirst = false } = {}) {
  const st = { flows: new Map(), codes: new Map(), tokens: new Set(), seen: [] };
  let base;
  const p1 = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, o, h = {}) => res.writeHead(code, { 'content-type': 'application/json', ...h }).end(JSON.stringify(o));
    const env = '/env-1';
    if (u.pathname === `${env}/as/.well-known/openid-configuration`) return json(200, { issuer: `${base}${env}/as`, authorization_endpoint: `${base}${env}/as/authorize`, token_endpoint: `${base}${env}/as/token`, response_modes_supported: ['pi.flow', 'query'], code_challenge_methods_supported: ['S256'] });
    if (u.pathname === `${env}/as/authorize`) {
      const p = Object.fromEntries(u.searchParams); st.authorize = p;
      if (p.response_mode !== 'pi.flow') return res.writeHead(302, { location: 'https://login.example/' }).end(); // a redirect login: must never be used
      const id = `flow${crypto.randomBytes(6).toString('hex')}`;
      st.flows.set(id, { p, status: identifierFirst ? 'SIGN_ON_REQUIRED' : 'USERNAME_PASSWORD_REQUIRED', cookie: `ST=${id}` });
      return json(200, { id, status: st.flows.get(id).status, _links: { self: { href: `${base}${env}/flows/${id}` } } }, { 'set-cookie': `ST=${id}; Path=/; HttpOnly` });
    }
    const fm = u.pathname.match(/^\/env-1\/flows\/([A-Za-z0-9]+)$/);
    if (fm) {
      const f = st.flows.get(fm[1]);
      if (!f) return json(404, { code: 'NOT_FOUND' });
      if (req.headers.cookie !== f.cookie) return json(400, { code: 'INVALID_REQUEST', message: 'session cookie missing' });
      const body = JSON.parse(await readBody(req)); const type = req.headers['content-type'];
      st.seen.push(type);
      if (type === 'application/vnd.pingidentity.user.lookup+json') { f.status = 'PASSWORD_REQUIRED'; return json(200, { id: fm[1], status: f.status }); }
      if (type !== 'application/vnd.pingidentity.usernamePassword.check+json') return json(415, { code: 'UNSUPPORTED_MEDIA_TYPE' });
      if (body.username !== 'alice' || body.password !== PASSWORD) return json(400, { code: 'INVALID_DATA', details: [{ code: 'INVALID_CREDENTIALS' }] });
      f.status = 'COMPLETED'; return json(200, { id: fm[1], status: 'COMPLETED' });
    }
    if (u.pathname === `${env}/as/resume`) {
      const f = st.flows.get(u.searchParams.get('flowId'));
      if (!f || f.status !== 'COMPLETED' || req.headers.cookie !== f.cookie) return json(400, { error: 'invalid_request' });
      const code = `c-${crypto.randomUUID()}`; st.codes.set(code, f.p);
      return json(200, { authorizeResponse: { code, state: f.p.state } });
    }
    if (u.pathname === `${env}/as/token`) {
      const p = Object.fromEntries(new URLSearchParams(await readBody(req))); st.tokenReq = p;
      const a = st.codes.get(p.code); st.codes.delete(p.code);
      if (!a || b64url(crypto.createHash('sha256').update(p.code_verifier || '').digest()) !== a.code_challenge || p.client_id !== 'p1-mcp-client') return json(400, { error: 'invalid_grant' });
      const t = `p1-access-${crypto.randomUUID()}`; st.tokens.add(t);
      return json(200, { access_token: t, token_type: 'Bearer', expires_in: 3600 });
    }
    res.writeHead(404).end();
  });
  base = p1;
  let mcpBase;
  mcpBase = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/oauth-protected-resource') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${mcpBase}/mcp`, authorization_servers: [`${base}/env-1/as`], scopes_supported: ['tools:read'] }));
    const body = await readBody(req);
    if (!st.tokens.has(String(req.headers.authorization || '').replace(/^Bearer /, ''))) return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcpBase}/.well-known/oauth-protected-resource"` }).end();
    const msg = JSON.parse(body || '{}');
    if (msg.id === undefined) return res.writeHead(202).end();
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'p1-protected', version: '1' }, capabilities: { tools: {} } } : { tools: [{ name: 'p1_tool', description: 'd', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  return { issuer: `${base}/env-1/as`, mcp: `${mcpBase}/mcp`, st };
}

test('our PingOne: discovery picks pi.flow, a redirect start is refused, the Sign in steps finish with a token', T, async () => {
  const w = await fakeP1();
  const app = await startApp({ env: { MCPTOOLS_P1_ISSUER: w.issuer, PINGONE_MCP_CLIENT_ID: 'p1-mcp-client' } });
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp, label: 'p1 protected' })).json.connection.id;
    const s0 = (await app.call('GET', `/api/connections/${id}/oauth`)).json;
    assert.equal(s0.method, 'piflow'); assert.equal(s0.refused, null); assert.equal(s0.signedIn, false);
    assert.equal((await app.call('POST', `/api/connections/${id}/oauth/start`, {})).json.error, 'oauth_use_piflow', 'never a redirect for our PingOne');
    const run = (await app.call('POST', `/api/connections/${id}/oauth/piflow`, {})).json;
    assert.equal(run.state, 'credentials_required'); assert.equal(run.status, 'USERNAME_PASSWORD_REQUIRED');
    assert.equal(w.st.authorize.response_mode, 'pi.flow'); assert.equal(w.st.authorize.resource, w.mcp); assert.equal(w.st.authorize.code_challenge_method, 'S256');
    assert.match(w.st.authorize.scope, /^openid tools:read$/);
    const flowIds = [...w.st.flows.keys()];
    assert.equal(flowIds.length, 1);
    assert.ok(!JSON.stringify(run).includes(flowIds[0]), 'the flow id (a bearer handle) never reaches the browser');
    const wrong = (await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: 'nope' })).json;
    assert.equal(wrong.state, 'credentials_required'); assert.match(wrong.refused, /not right/);
    const ok = await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD });
    assert.equal(ok.json.state, 'signed_in');
    assert.equal(w.st.tokenReq.resource, w.mcp);
    assert.ok(!ok.text.includes(PASSWORD) && !/p1-access-/.test(ok.text));
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, true);
    assert.equal((await app.call('GET', `/api/connections/${id}/tools`)).json.tools[0].name, 'p1_tool');
    assert.equal((await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD })).status, 409, 'a run is single use');
  } finally { await app.close(); }
});

test('identifier-first policy: user.lookup, then the password', T, async () => {
  const w = await fakeP1({ identifierFirst: true });
  const app = await startApp({ env: { MCPTOOLS_P1_ISSUER: w.issuer, PINGONE_MCP_CLIENT_ID: 'p1-mcp-client' } });
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const run = (await app.call('POST', `/api/connections/${id}/oauth/piflow`, {})).json;
    assert.equal(run.status, 'SIGN_ON_REQUIRED');
    const ok = (await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD })).json;
    assert.equal(ok.state, 'signed_in');
    assert.deepEqual(w.st.seen, ['application/vnd.pingidentity.user.lookup+json', 'application/vnd.pingidentity.usernamePassword.check+json']);
  } finally { await app.close(); }
});

test('no client id: our PingOne is named and PINGONE_MCP_CLIENT_ID is asked for; a run cannot be finished from another connection', T, async () => {
  const w = await fakeP1();
  const none = await startApp({ env: { MCPTOOLS_P1_ISSUER: w.issuer } });
  try {
    const id = (await none.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const s = (await none.call('GET', `/api/connections/${id}/oauth`)).json;
    assert.equal(s.method, 'piflow'); assert.match(s.refused, /PINGONE_MCP_CLIENT_ID/);
  } finally { await none.close(); }
  const app = await startApp({ env: { MCPTOOLS_P1_ISSUER: w.issuer, PINGONE_MCP_CLIENT_ID: 'p1-mcp-client' } });
  try {
    const a = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const b = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const run = (await app.call('POST', `/api/connections/${a}/oauth/piflow`, {})).json;
    const r = await app.call('POST', `/api/connections/${b}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD });
    assert.equal(r.status, 409);
    assert.equal((await app.call('GET', `/api/connections/${b}/oauth`)).json.signedIn, false);
    assert.equal((await app.call('POST', `/api/connections/${a}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD }, { origin: 'http://evil.example' })).status, 403, 'credentials are same-origin');
  } finally { await app.close(); }
});

test('the PingOne hosted connection signs in by pi.flow too (no redirect, no callback)', T, async () => {
  const w = await fakeP1();
  const app = await startApp({ env: { MCPTOOLS_PINGONE: '1', MCPTOOLS_P1_ISSUER: w.issuer, MCPTOOLS_P1_MCP_URL: w.mcp, PINGONE_ENVIRONMENT_ID: 'env-1', PINGONE_MCP_CLIENT_ID: 'p1-mcp-client' } });
  try {
    const run = (await app.call('POST', '/api/pingone/login', {})).json;
    assert.equal(run.state, 'credentials_required');
    assert.equal(w.st.authorize.response_mode, 'pi.flow');
    assert.equal((await app.call('POST', '/api/pingone/credentials', { run: run.run, username: 'alice', password: PASSWORD })).json.state, 'signed_in');
    assert.equal((await app.call('GET', '/api/pingone/status')).json.signedIn, true);
    const c = await app.call('POST', '/api/connections', { transport: 'pingone' });
    assert.equal(c.json.test.ok, true);
    assert.equal((await app.call('GET', `/api/connections/${c.json.connection.id}/tools`)).json.tools[0].name, 'p1_tool');
    assert.equal((await app.call('GET', '/api/pingone/callback')).status, 404, 'the redirect callback is gone');
  } finally { await app.close(); }
});
