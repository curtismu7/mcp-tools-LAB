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

// aud: the audience put in the access token (default: the resource asked for, as a PingOne that knows it; 'opaque' = a non-JWT token;
// a function gets the resource). refreshAud: same for a refreshed token (turns on refresh_token and a 20 s lifetime).
async function fakeP1({ identifierFirst = false, resource, scopes = ['tools:read'], scopeChallenge, wrongState = false, omitState = false, otp = false, aud, refreshAud } = {}) {
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
      f.status = otp ? 'OTP_REQUIRED' : 'COMPLETED'; return json(200, { id: fm[1], status: f.status });
    }
    if (u.pathname === `${env}/as/resume`) {
      const f = st.flows.get(u.searchParams.get('flowId'));
      if (!f || f.status !== 'COMPLETED' || req.headers.cookie !== f.cookie) return json(400, { error: 'invalid_request' });
      const code = `c-${crypto.randomUUID()}`; st.codes.set(code, f.p);
      return json(200, { authorizeResponse: { code, ...(omitState ? {} : { state: wrongState ? 'not-the-state' : f.p.state }) } });
    }
    if (u.pathname === `${env}/as/token`) {
      const p = Object.fromEntries(new URLSearchParams(await readBody(req))); st.tokenReq = p;
      const mint = (want) => {
        if (want === 'opaque') return `p1-access-${crypto.randomUUID()}`;
        const claims = { iss: `${base}${env}/as`, aud: typeof want === 'function' ? want(p.resource) : want === undefined ? p.resource : want, scope: 'openid' };
        return `p1-access-${crypto.randomUUID()}.${b64url(Buffer.from(JSON.stringify(claims)))}.sig`;
      };
      if (p.grant_type === 'refresh_token') {
        st.refreshReq = p;
        if (p.refresh_token !== 'p1-refresh-1') return json(400, { error: 'invalid_grant' });
        const t = mint(refreshAud); st.tokens.add(t);
        return json(200, { access_token: t, token_type: 'Bearer', expires_in: 20, refresh_token: 'p1-refresh-1' });
      }
      const a = st.codes.get(p.code); st.codes.delete(p.code);
      if (!a || b64url(crypto.createHash('sha256').update(p.code_verifier || '').digest()) !== a.code_challenge || p.client_id !== 'p1-mcp-client') return json(400, { error: 'invalid_grant' });
      const t = mint(aud); st.tokens.add(t);
      return json(200, { access_token: t, token_type: 'Bearer', expires_in: refreshAud !== undefined ? 20 : 3600, ...(refreshAud !== undefined ? { refresh_token: 'p1-refresh-1' } : {}) });
    }
    res.writeHead(404).end();
  });
  base = p1;
  let mcpBase;
  mcpBase = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/oauth-protected-resource') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: resource || `${mcpBase}/mcp`, authorization_servers: [`${base}/env-1/as`], scopes_supported: scopes }));
    const body = await readBody(req);
    if (req.headers.authorization) (st.bearers ||= []).push(req.headers.authorization);
    if (!st.tokens.has(String(req.headers.authorization || '').replace(/^Bearer /, ''))) return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcpBase}/.well-known/oauth-protected-resource"` }).end();
    const msg = JSON.parse(body || '{}');
    if (msg.id === undefined) return res.writeHead(202).end();
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'p1-protected', version: '1' }, capabilities: { tools: {} } } : { tools: [{ name: 'p1_tool', description: 'd', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  return { issuer: `${base}/env-1/as`, mcp: `${mcpBase}/mcp`, st };
}

import { createPiFlow } from '../src/piflow.js';
import { checkAudience, parseResourceMap } from '../src/oauth.js';
import { loadSharedP1, p1Config } from '../src/p1config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('our PingOne: discovery picks pi.flow, a redirect start is refused, the Sign in steps finish with a token', T, async () => {
  const w = await fakeP1();
  const app = await startApp({ env: { MCPTOOLS_P1_ISSUER: w.issuer, PINGONE_MCP_CLIENT_ID: 'p1-mcp-client', MCPTOOLS_P1_SCOPES: 'tools:read' } });
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

const ENV = { MCPTOOLS_P1_ISSUER: undefined, PINGONE_MCP_CLIENT_ID: 'p1-mcp-client' };
const startRun = async (w, now, extra = {}) => createPiFlow({ now }).start({ key: 'k', meta: { issuer: w.issuer, authorizationEndpoint: `${w.issuer}/authorize`, tokenEndpoint: `${w.issuer}/token` }, clientId: 'p1-mcp-client', redirectUri: 'http://127.0.0.1:1/cb', resource: w.mcp, scope: 'openid', onTokens: () => {}, ...extra });

test('the token audience is the connection URL, never what the server says; scopes come from an allowlist, not the server', T, async () => {
  const hostile = await fakeP1({ resource: 'https://victim.example/admin-api', scopes: ['p1:update:user'] });
  const app = await startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: hostile.issuer } });
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: hostile.mcp })).json.connection.id;
    const d = await app.call('GET', `/api/connections/${id}/oauth`);
    assert.equal(d.status, 400); assert.equal(d.json.error, 'oauth_resource_mismatch');
    assert.equal(hostile.st.authorize, undefined, 'PingOne was never asked for a token');
  } finally { await app.close(); }
  const w = await fakeP1({ scopes: ['tools:read', 'p1:update:user'] });
  const none = await startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: w.issuer } }); // no allowlist
  try {
    const id = (await none.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    await none.call('POST', `/api/connections/${id}/oauth/piflow`, {});
    assert.equal(w.st.authorize.scope, 'openid', 'the server cannot choose what our PingOne grants');
    assert.equal(w.st.authorize.resource, w.mcp);
  } finally { await none.close(); }
  const w2 = await fakeP1({ scopes: ['tools:read', 'p1:update:user'] });
  const some = await startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: w2.issuer, MCPTOOLS_P1_SCOPES: 'tools:read' } });
  try {
    const id = (await some.call('POST', '/api/connections', { transport: 'http', url: w2.mcp })).json.connection.id;
    await some.call('POST', `/api/connections/${id}/oauth/piflow`, {});
    assert.equal(w2.st.authorize.scope, 'openid tools:read');
  } finally { await some.close(); }
});

test('at most 5 sign-in starts a minute per connection (a new run is otherwise a free password try)', T, async () => {
  const w = await fakeP1();
  const app = await startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: w.issuer } });
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    for (let i = 0; i < 5; i += 1) assert.equal((await app.call('POST', `/api/connections/${id}/oauth/piflow`, {})).status, 200);
    const r = await app.call('POST', `/api/connections/${id}/oauth/piflow`, {});
    assert.equal(r.status, 429); assert.equal(r.json.error, 'piflow_rate_limited');
  } finally { await app.close(); }
});

test('a run expires after 5 minutes, allows five password tries, and refuses a password when PingOne is at another step', T, async () => {
  const w = await fakeP1();
  let t = 5_000_000;
  const flow = createPiFlow({ now: () => t });
  const mk = () => flow.start({ key: `k${t}`, meta: { issuer: w.issuer, authorizationEndpoint: `${w.issuer}/authorize`, tokenEndpoint: `${w.issuer}/token` }, clientId: 'p1-mcp-client', redirectUri: 'http://127.0.0.1:1/cb', resource: w.mcp, scope: 'openid', onTokens: () => {} });
  const run = await mk();
  t += 5 * 60 * 1000 + 1;
  await assert.rejects(flow.credentials(run.run, { username: 'alice', password: PASSWORD }, `k${t - 5 * 60 * 1000 - 1}`), /expired/);
  const r2 = await mk(); const key2 = `k${t}`;
  for (let i = 0; i < 5; i += 1) assert.equal((await flow.credentials(r2.run, { username: 'alice', password: 'nope' }, key2)).state, 'credentials_required');
  await assert.rejects(flow.credentials(r2.run, { username: 'alice', password: 'nope' }, key2), /too many sign-in steps/);
  const w2 = await fakeP1({ otp: true });
  const f2 = createPiFlow();
  const r3 = await f2.start({ key: 'o', meta: { issuer: w2.issuer, authorizationEndpoint: `${w2.issuer}/authorize`, tokenEndpoint: `${w2.issuer}/token` }, clientId: 'p1-mcp-client', redirectUri: 'http://127.0.0.1:1/cb', scope: 'openid', onTokens: () => {} });
  const stopped = await f2.credentials(r3.run, { username: 'alice', password: PASSWORD }, 'o');
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.status, 'OTP_REQUIRED');
  await assert.rejects(f2.credentials(r3.run, { username: 'alice', password: PASSWORD }, 'o'), /not waiting for a password/);
});

test('the code must come back with our state: a different state, or none, is refused', T, async () => {
  for (const opts of [{ wrongState: true }, { omitState: true }]) {
    const w = await fakeP1(opts);
    const f = createPiFlow();
    const run = await f.start({ key: 'k', meta: { issuer: w.issuer, authorizationEndpoint: `${w.issuer}/authorize`, tokenEndpoint: `${w.issuer}/token` }, clientId: 'p1-mcp-client', redirectUri: 'http://127.0.0.1:1/cb', scope: 'openid', onTokens: () => { throw new Error('a token must not be kept'); } });
    await assert.rejects(f.credentials(run.run, { username: 'alice', password: PASSWORD }, 'k'), /different state/);
    assert.equal(w.st.tokenReq, undefined, 'the code was never redeemed');
  }
});

test('startup copies only the five PingOne keys (three ids, two settings) from the shared settings file, real env wins, and an unsafe issuer override is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, ['PINGONE_ENVIRONMENT_ID=env-from-file', 'PINGONE_REGION=eu', 'PINGONE_MCP_CLIENT_ID=client-from-file', 'MCPTOOLS_P1_SCOPES=tools', 'MCPTOOLS_P1_RESOURCES=http://127.0.0.1:1/mcp=aud-x', 'PINGONE_CLIENT_SECRET=must-not-load', 'MCPTOOLS_P1_ISSUER=https://evil.example/as', 'MCPTOOLS_TOKEN=must-not-load', 'OTHER=1'].join('\n'));
  const env = { STANDALONE_ENV: file, PINGONE_REGION: 'com' };
  loadSharedP1(env);
  assert.deepEqual(Object.keys(env).sort(), ['MCPTOOLS_P1_RESOURCES', 'MCPTOOLS_P1_SCOPES', 'PINGONE_ENVIRONMENT_ID', 'PINGONE_MCP_CLIENT_ID', 'PINGONE_REGION', 'STANDALONE_ENV']);
  assert.equal(env.PINGONE_REGION, 'com', 'a real env var wins');
  assert.equal(p1Config(env).issuer, 'https://auth.pingone.com/env-from-file/as');
  assert.equal(p1Config({ ...env, MCPTOOLS_P1_ISSUER: 'http://auth.example.test/as' }).issuer, 'https://auth.pingone.com/env-from-file/as', 'plain http to a non-loopback host is ignored');
  assert.equal(p1Config({ ...env, MCPTOOLS_P1_ISSUER: 'http://127.0.0.1:9/env/as' }).issuer, 'http://127.0.0.1:9/env/as');
  assert.equal(p1Config({ ...env, MCPTOOLS_P1_ISSUER: 'https://id.example.test/env/as' }).issuer, 'https://id.example.test/env/as');
  fs.rmSync(dir, { recursive: true });
});

// Our PingOne ignores a resource it does not know and issues its own API audience (measured live 2026-11-08). The tool must
// not keep such a token or send it to the server that asked for the sign-in.
async function signInWith(opts) {
  const w = await fakeP1(opts);
  const app = await startApp({ env: { MCPTOOLS_P1_ISSUER: w.issuer, PINGONE_MCP_CLIENT_ID: 'p1-mcp-client' } });
  const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
  const run = (await app.call('POST', `/api/connections/${id}/oauth/piflow`, {})).json;
  const done = await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD });
  return { w, app, id, done };
}

test('a token for another audience (PingOne API) is refused: not kept, not sent, and the message says what to do', T, async () => {
  const { w, app, id, done } = await signInWith({ aud: 'https://api.pingone.example' });
  try {
    assert.equal(done.status, 400); assert.equal(done.json.error, 'oauth_audience_mismatch');
    assert.match(done.json.message, /api\.pingone\.example/); assert.match(done.json.message, /resource in the PingOne environment/);
    assert.ok(!/p1-access-/.test(done.text) && !done.text.includes(PASSWORD), 'neither the token nor the password is echoed');
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
    await app.call('GET', `/api/connections/${id}/tools`);
    assert.equal(w.st.bearers?.length ?? 0, 0, 'the server never received that token');
  } finally { await app.close(); }
});

test('an opaque token cannot be checked, so it is refused too', T, async () => {
  const { app, id, done } = await signInWith({ aud: 'opaque' });
  try {
    assert.equal(done.json.error, 'oauth_audience_mismatch'); assert.match(done.json.message, /none readable/);
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
  } finally { await app.close(); }
});

test('an audience that is only the server (a one-item list, or the URL with a trailing slash) is accepted', T, async () => {
  for (const aud of [(r) => [r], (r) => `${r}/`]) {
    const { w, app, id, done } = await signInWith({ aud });
    try {
      assert.equal(done.json.state, 'signed_in');
      assert.equal((await app.call('GET', `/api/connections/${id}/tools`)).json.tools[0].name, 'p1_tool');
      assert.ok(w.st.bearers.length > 0);
    } finally { await app.close(); }
  }
});

test('checkAudience: exact server URL only (no prefix, suffix, other host or non-string audience)', () => {
  const jwt = (aud) => `h.${Buffer.from(JSON.stringify({ aud })).toString('base64url')}.s`;
  const R = 'http://127.0.0.1:4821/mcp';
  for (const ok of [R, `${R}/`, [R], [R, `${R}/`]]) assert.doesNotThrow(() => checkAudience(jwt(ok), R));
  for (const bad of [['x', R], [R, 'https://api.pingone.com'], ['https://api.pingone.com', R], [R, 1], `${R}/more`, 'http://127.0.0.1:4821', `${R}x`, 'http://127.0.0.1:4822/mcp', 'https://api.pingone.com', [], [1, null], null, undefined, { a: R }]) {
    assert.throws(() => checkAudience(jwt(bad), R), (e) => e.code === 'oauth_audience_mismatch', JSON.stringify(bad));
  }
  for (const junk of ['', 'not-a-jwt', 'a.b.c', 'a..c', `a.${Buffer.from('[1]').toString('base64url')}.c`]) assert.throws(() => checkAudience(junk, R), (e) => e.code === 'oauth_audience_mismatch');
});

test('a refreshed token is checked too: a wrong audience signs the connection out and is never sent', T, async () => {
  const { w, app, id, done } = await signInWith({ refreshAud: 'https://api.pingone.example' });
  try {
    assert.equal(done.json.state, 'signed_in'); // the first token names the server
    await app.call('GET', `/api/connections/${id}/tools`); // 20 s lifetime: this call refreshes first
    assert.ok(w.st.refreshReq, 'a refresh was attempted');
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
    assert.ok(!(w.st.bearers || []).some((b) => /\.[A-Za-z0-9_-]+\.sig$/.test(b) && Buffer.from(b.split('.')[1], 'base64url').toString().includes('api.pingone.example')), 'the wrong-audience token never reached the server');
  } finally { await app.close(); }
});

test('a refreshed token for the right audience keeps the sign-in', T, async () => {
  const { w, app, id } = await signInWith({ refreshAud: (r) => r });
  try {
    await app.call('GET', `/api/connections/${id}/tools`);
    assert.ok(w.st.refreshReq);
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, true);
  } finally { await app.close(); }
});

test("a list that also names PingOne's API is refused (it would work there), the message hides the URL query, and a long slash run stays fast", T, async () => {
  const { w, app, id, done } = await signInWith({ aud: (r) => [r, 'https://api.pingone.example'] });
  try {
    assert.equal(done.json.error, 'oauth_audience_mismatch'); assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
    assert.equal(w.st.bearers?.length ?? 0, 0);
  } finally { await app.close(); }
  const jwt = (aud) => `h.${Buffer.from(JSON.stringify({ aud })).toString('base64url')}.s`;
  const msgOf = (aud, res) => { try { checkAudience(jwt(aud), res); } catch (e) { return e.message; } return ''; };
  const msg = msgOf('https://api.pingone.example', `https://srv.example/mcp?key=${'S'.repeat(30)}END#frag`);
  assert.match(msg, /srv\.example\/mcp/); assert.ok(!/SSS|key=|frag|END/.test(msg), 'no query or fragment in the message');
  const t0 = Date.now(); assert.throws(() => checkAudience(jwt(`${'/'.repeat(60_000)}x`), 'http://127.0.0.1:1/mcp')); assert.ok(Date.now() - t0 < 500, 'linear time');
  assert.doesNotMatch(msgOf('bad\n<script>‮', 'http://127.0.0.1:1/mcp'), /[^\x20-\x7e]/, 'printable ASCII only');
});

// MCPTOOLS_P1_RESOURCES maps ONE connection URL to ONE audience in our PingOne (a server that names such an audience in its
// metadata, like the Banking MCP server). The server alone can never choose.
test('a mapped audience is requested, checked and accepted: only for that URL, only when the server names exactly it', T, async () => {
  const probe = await fakeP1({ resource: 'banking.example.demo' });
  const withMap = (w, url) => startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: w.issuer, MCPTOOLS_P1_RESOURCES: `${url}=banking.example.demo` } });
  const signIn = async (app, w) => {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const run = (await app.call('POST', `/api/connections/${id}/oauth/piflow`, {})).json;
    const done = await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD });
    return { id, run, done };
  };
  // 1. mapped and named: the audience is the mapped one, PingOne is asked for it, the token's aud is checked against it
  const app = await withMap(probe, probe.mcp);
  try {
    const { id, done } = await signIn(app, probe);
    assert.equal(done.json.state, 'signed_in');
    assert.equal(probe.st.authorize.resource, 'banking.example.demo'); assert.equal(probe.st.tokenReq.resource, 'banking.example.demo');
    assert.equal((await app.call('GET', `/api/connections/${id}/tools`)).json.tools[0].name, 'p1_tool');
    assert.ok(probe.st.bearers.length > 0);
    assert.deepEqual(probe.st.bearers.map((b) => JSON.parse(Buffer.from(b.split('.')[1], 'base64url')).aud), probe.st.bearers.map(() => 'banking.example.demo'), 'every token sent carries the mapped audience');
  } finally { await app.close(); }
  // 2. the server names a different audience than the one mapped: refused, PingOne never asked
  const other = await fakeP1({ resource: 'someone-elses.example.demo' });
  const a2 = await withMap(other, other.mcp);
  try {
    const id = (await a2.call('POST', '/api/connections', { transport: 'http', url: other.mcp })).json.connection.id;
    const d = await a2.call('GET', `/api/connections/${id}/oauth`);
    assert.equal(d.json.error, 'oauth_resource_mismatch'); assert.match(d.json.message, /MCPTOOLS_P1_RESOURCES/); assert.equal(other.st.authorize, undefined);
  } finally { await a2.close(); }
  // 3. the mapping belongs to another URL: this server cannot use it
  const third = await fakeP1({ resource: 'banking.example.demo' });
  const a3 = await withMap(third, 'http://127.0.0.1:1/mcp');
  try {
    const id = (await a3.call('POST', '/api/connections', { transport: 'http', url: third.mcp })).json.connection.id;
    assert.equal((await a3.call('GET', `/api/connections/${id}/oauth`)).json.error, 'oauth_resource_mismatch'); assert.equal(third.st.authorize, undefined);
  } finally { await a3.close(); }
  // 4. mapped, but our PingOne does not know that resource (issues its own API audience): the token is refused as before
  const unknown = await fakeP1({ resource: 'banking.example.demo', aud: 'https://api.pingone.example' });
  const a4 = await withMap(unknown, unknown.mcp);
  try {
    const { done, id } = await signIn(a4, unknown);
    assert.equal(done.json.error, 'oauth_audience_mismatch'); assert.equal((await a4.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false); assert.equal(unknown.st.bearers?.length ?? 0, 0);
  } finally { await a4.close(); }
  // 5. a server that names its own URL is unaffected by an unrelated mapping
  const plain = await fakeP1();
  const a5 = await withMap(plain, 'http://127.0.0.1:1/mcp');
  try { assert.equal((await signIn(a5, plain)).done.json.state, 'signed_in'); assert.equal(plain.st.authorize.resource, plain.mcp); } finally { await a5.close(); }
});

test('the mapping is exact: same origin with another path or query does not get it', T, async () => {
  const w = await fakeP1({ resource: 'banking.example.demo' });
  for (const suffix of ['/other', '?x=1']) { // the mapped key is <mcp>; <mcp>/other and <mcp>?x=1 are different URLs
    const url = `${w.mcp}${suffix}`;
    const app = await startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: w.issuer, MCPTOOLS_P1_RESOURCES: `${w.mcp}=banking.example.demo` } });
    try {
      const id = (await app.call('POST', '/api/connections', { transport: 'http', url })).json.connection.id;
      assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.error, 'oauth_resource_mismatch', suffix);
    } finally { await app.close(); }
  }
  assert.equal(w.st.authorize, undefined, 'PingOne was never asked');
});

test('a refreshed token for a mapped (non-URL) audience is checked too', T, async () => {
  const w = await fakeP1({ resource: 'banking.example.demo', aud: (r) => r, refreshAud: 'https://api.pingone.example' });
  const app = await startApp({ env: { ...ENV, MCPTOOLS_P1_ISSUER: w.issuer, MCPTOOLS_P1_RESOURCES: `${w.mcp}=banking.example.demo` } });
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const run = (await app.call('POST', `/api/connections/${id}/oauth/piflow`, {})).json;
    assert.equal((await app.call('POST', `/api/connections/${id}/oauth/piflow/credentials`, { run: run.run, username: 'alice', password: PASSWORD })).json.state, 'signed_in');
    await app.call('GET', `/api/connections/${id}/tools`); // 20 s lifetime: this call refreshes first
    assert.ok(w.st.refreshReq); assert.equal(w.st.refreshReq.resource, 'banking.example.demo');
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
  } finally { await app.close(); }
});

test('the mapping never applies to a server that signs in with another authorization server', T, async () => {
  const { world, closeAll } = await import('./fixtures/oauthWorld.js');
  const w = await world({ resource: 'banking.example.demo' });
  const app = await startApp({ env: { MCPTOOLS_P1_RESOURCES: `${w.mcp}=banking.example.demo` } });
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const d = await app.call('GET', `/api/connections/${id}/oauth`);
    assert.equal(d.json.error, 'oauth_resource_mismatch'); assert.doesNotMatch(d.json.message, /MCPTOOLS_P1_RESOURCES/);
  } finally { await app.close(); await closeAll(); }
});

test('parseResourceMap: URL=audience pairs, last = splits, junk and Ping API audiences are skipped', () => {
  const m = parseResourceMap('http://127.0.0.1:8081/mcp=mcp-invest.ping.demo, https://srv.example/mcp/=https://aud.example/x https://q.example/mcp?k=v=aud-q  bad  =x nourl=a http://h/=  ftp://f/mcp=aud https://api.pingone.com=https://api.pingone.com http://p/mcp=api.pingone.eu http://q/mcp=my-pingone.example');
  assert.deepEqual([...m], [['http://127.0.0.1:8081/mcp', 'mcp-invest.ping.demo'], ['https://srv.example/mcp', 'https://aud.example/x'], ['https://q.example/mcp?k=v', 'aud-q']]);
  assert.equal(parseResourceMap('http://a/mcp=https://api.pingone.com. http://b/mcp=api.pingone.com. http://c/mcp=api.pingone.com:443 http://d/mcp=urn:x:pingone http://e/mcp=pingone:api http://f/mcp=PINGONE').size, 0, 'Ping API audiences are dropped in every spelling');
  assert.equal(parseResourceMap('').size, 0); assert.equal(parseResourceMap(undefined).size, 0);
  assert.equal(parseResourceMap(`http://h/mcp=${'a'.repeat(201)}`).size, 0, 'an over-long audience is skipped');
});
