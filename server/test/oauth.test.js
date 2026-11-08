// Third-party OAuth sign-in (rule-16 exception): a fake authorization server and a fake protected MCP server, both on
// loopback. The "browser" is this test following the authorize redirect.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { afterEach } from 'node:test';
import { startApp } from './helpers.js';
import { isPingHost, parseChallenge } from '../src/oauth.js';

const T = { timeout: 20_000 };
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))); });
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); servers.push(s); s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)); });
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A fake authorization server + protected MCP server. `opts` bends them for the negative tests.
async function world(opts = {}) {
  const st = { codes: new Map(), tokens: new Set(), registered: [], tokenCalls: [], mcpAuth: [], expiresIn: opts.expiresIn ?? 3600 };
  let mcpUrl;
  const as = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: opts.wrongIssuer ? 'http://127.0.0.1:1' : as, authorization_endpoint: `${as}/authorize`, token_endpoint: `${as}/token`, ...(opts.noRegistration ? {} : { registration_endpoint: `${as}/register` }), code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') { const body = JSON.parse(await readBody(req)); st.registered.push(body); return json(201, { client_id: 'dyn-client-1' }); }
    if (u.pathname === '/authorize') {
      const p = Object.fromEntries(u.searchParams);
      st.lastAuthorize = p;
      const code = `code-${crypto.randomUUID()}`;
      st.codes.set(code, p);
      const back = new URL(p.redirect_uri);
      back.search = new URLSearchParams({ code, state: p.state, ...(opts.iss !== undefined ? { iss: opts.iss } : { iss: as }) }).toString();
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (u.pathname === '/token') {
      const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
      st.tokenCalls.push(p);
      if (p.grant_type === 'authorization_code') {
        const a = st.codes.get(p.code); st.codes.delete(p.code);
        if (!a || b64url(crypto.createHash('sha256').update(p.code_verifier || '').digest()) !== a.code_challenge || p.redirect_uri !== a.redirect_uri || p.resource !== a.resource) return json(400, { error: 'invalid_grant' });
      } else if (p.grant_type !== 'refresh_token' || p.refresh_token !== 'refresh-secret-1') return json(400, { error: 'invalid_grant' });
      const t = `access-secret-${crypto.randomUUID()}`; st.tokens.add(t);
      return json(200, { access_token: t, token_type: 'Bearer', expires_in: st.expiresIn, refresh_token: 'refresh-secret-1' });
    }
    res.writeHead(404).end();
  });
  mcpUrl = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/oauth-protected-resource') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${mcpUrl}/mcp`, authorization_servers: [opts.asOverride || as], scopes_supported: ['tools:read'] }));
    const body = await readBody(req);
    const auth = req.headers.authorization || '';
    st.mcpAuth.push(auth);
    if (!st.tokens.has(auth.replace(/^Bearer /, ''))) return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcpUrl}/.well-known/oauth-protected-resource", scope="tools:read"` }).end();
    const msg = JSON.parse(body || '{}');
    if (msg.id === undefined) return res.writeHead(202).end();
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'protected', version: '1' }, capabilities: { tools: {} } } : msg.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'w', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: `echo ${auth}` }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  return { as, mcp: `${mcpUrl}/mcp`, st };
}
async function signIn(app, id, body = {}) {
  const start = await app.call('POST', `/api/connections/${id}/oauth/start`, body);
  if (start.status !== 200) return { start };
  const toAs = await fetch(start.json.authorizeUrl, { redirect: 'manual' }); // the browser goes to the AS ...
  const back = toAs.headers.get('location');
  const cb = await fetch(back, { redirect: 'manual', headers: { Connection: 'close' } }); // ... and back to this tool
  return { start, cb, text: await cb.text() };
}

test('isPingHost refuses Ping authorization servers (heuristic) and nothing else', () => {
  for (const h of ['auth.pingone.com', 'auth.pingone.eu', 'x.pingidentity.com', 'placeholder.ping-devops.com', 'pingfederate.example.com', 'my-pingone.example']) assert.ok(isPingHost(h), h);
  for (const h of ['auth.example.com', 'login.microsoftonline.com', 'accounts.google.com', 'shopping.example', 'ping.example']) assert.ok(!isPingHost(h), h);
  assert.deepEqual(parseChallenge('Bearer resource_metadata="https://a/b", scope="x y"'), { resource_metadata: 'https://a/b', scope: 'x y' });
});

test('discover, register, sign in with PKCE + resource + state, then list tools with the token; no token in any reply', T, async () => {
  const w = await world();
  const app = await startApp();
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp, label: 'protected' })).json.connection.id;
    const s0 = (await app.call('GET', `/api/connections/${id}/oauth`)).json;
    assert.equal(s0.required, true); assert.equal(s0.signedIn, false); assert.equal(s0.issuer, w.as);
    assert.deepEqual(s0.scopes, ['tools:read']); assert.equal(s0.dynamicRegistration, true); assert.equal(s0.refused, null);
    assert.equal((await app.call('GET', `/api/connections/${id}/tools`)).status, 502, 'not signed in: the server refuses');
    const { start, cb, text } = await signIn(app, id);
    assert.equal(start.json.registration, 'dynamic');
    assert.deepEqual(w.st.registered[0].redirect_uris, [`${app.origin}/api/oauth/callback`]);
    assert.equal(w.st.registered[0].token_endpoint_auth_method, 'none');
    const a = w.st.lastAuthorize;
    assert.equal(a.code_challenge_method, 'S256'); assert.equal(a.resource, w.mcp); assert.equal(a.scope, 'tools:read'); assert.ok(a.state.length >= 32);
    assert.equal(cb.status, 200); assert.match(text, /Signed in/);
    const s1 = (await app.call('GET', `/api/connections/${id}/oauth`)).json;
    assert.equal(s1.signedIn, true); assert.equal(s1.canRefresh, true);
    const tools = await app.call('GET', `/api/connections/${id}/tools`);
    assert.equal(tools.json.tools[0].name, 'whoami');
    // the token never comes back: not in status, not in a tool result that echoes it, not in the connection list
    const call = await app.call('POST', `/api/connections/${id}/call/preview`, { tool: 'whoami', arguments: {} });
    const res = await app.call('POST', `/api/connections/${id}/call`, { tool: 'whoami', arguments: {}, confirm: true, argsHash: call.json.argsHash });
    const all = [JSON.stringify(s1), res.text, (await app.call('GET', '/api/connections')).text].join('\n');
    assert.ok(!/access-secret-|refresh-secret-/.test(all), 'no token in any reply');
    assert.match(res.text, /\[redacted\]/);
    // the same state cannot be used twice
    const again = await fetch(cb.url, { headers: { Connection: 'close' } });
    assert.equal(again.status, 400);
    // sign out forgets it
    await app.call('POST', `/api/connections/${id}/oauth/signout`);
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
  } finally { await app.close(); }
});

test('the live proxy uses the signed-in token upstream; Reset and delete forget the sign-in', T, async () => {
  const w = await world();
  const app = await startApp();
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    await signIn(app, id);
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const r = await fetch(`${app.origin}/proxy/mcp/${id}`, { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    assert.equal(r.status, 200);
    assert.ok(w.st.mcpAuth.at(-1).startsWith('Bearer access-secret-'), 'upstream got the OAuth token, not the proxy token');
    await app.call('POST', '/api/reset');
    const again = await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp });
    assert.equal((await app.call('GET', `/api/connections/${again.json.connection.id}/oauth`)).json.signedIn, false);
  } finally { await app.close(); }
});

test('an expiring token is refreshed before use', T, async () => {
  const w = await world({ expiresIn: 1 }); // under the 30 s margin: refreshed on the next call
  const app = await startApp();
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    await signIn(app, id);
    const before = w.st.tokenCalls.length;
    assert.equal((await app.call('GET', `/api/connections/${id}/tools`)).status, 200);
    assert.ok(w.st.tokenCalls.slice(before).some((c) => c.grant_type === 'refresh_token'));
  } finally { await app.close(); }
});

test('refusals: a Ping authorization server, a wrong callback issuer, a bad state, a mismatched metadata issuer, no registration without a client id', T, async () => {
  const app = await startApp();
  try {
    const ping = await world({ asOverride: 'https://auth.pingone.com/env-placeholder/as' });
    const pid = (await app.call('POST', '/api/connections', { transport: 'http', url: ping.mcp })).json.connection.id;
    const ps = (await app.call('GET', `/api/connections/${pid}/oauth`)).json;
    assert.match(ps.refused, /pi\.flow only \(rule 16\)/);
    assert.equal((await app.call('POST', `/api/connections/${pid}/oauth/start`, {})).json.error, 'oauth_ping_refused');

    const wrongIss = await world({ iss: 'http://127.0.0.1:9/evil' });
    const wid = (await app.call('POST', '/api/connections', { transport: 'http', url: wrongIss.mcp })).json.connection.id;
    const r1 = await signIn(app, wid);
    assert.equal(r1.cb.status, 400); assert.match(r1.text, /different issuer/);
    assert.equal((await app.call('GET', `/api/connections/${wid}/oauth`)).json.signedIn, false);

    const cb = await fetch(`${app.origin}/api/oauth/callback?code=x&state=not-ours`, { headers: { Connection: 'close' } });
    assert.equal(cb.status, 400);
    const forged = await fetch(`${app.origin}/api/oauth/callback?code=<script>x</script>&error=<b>x</b>&state=nope`, { headers: { Connection: 'close' } });
    assert.ok(!(await forged.text()).includes('<script>'));

    const badMeta = await world({ wrongIssuer: true });
    const bid = (await app.call('POST', '/api/connections', { transport: 'http', url: badMeta.mcp })).json.connection.id;
    assert.equal((await app.call('GET', `/api/connections/${bid}/oauth`)).json.error, 'oauth_issuer_mismatch');

    const noReg = await world({ noRegistration: true });
    const nid = (await app.call('POST', '/api/connections', { transport: 'http', url: noReg.mcp })).json.connection.id;
    assert.equal((await app.call('POST', `/api/connections/${nid}/oauth/start`, {})).json.error, 'oauth_needs_client_id');
    const manual = await signIn(app, nid, { clientId: 'typed-client' });
    assert.equal(manual.start.json.registration, 'manual');
    assert.equal(manual.cb.status, 200);
    assert.equal((await app.call('POST', `/api/connections/${nid}/oauth/start`, { clientId: 5 })).status, 400);
    assert.equal((await app.call('POST', `/api/connections/${nid}/oauth/start`, {}, { origin: 'http://evil.example' })).status, 403, 'start is same-origin');
  } finally { await app.close(); }
});

test('a MOCK_ONLY copy refuses OAuth', T, async () => {
  const app = await startApp({ env: { MOCK_ONLY: '1' } });
  try { assert.equal((await app.call('GET', '/api/connections/mock-sample/oauth')).status, 403); } finally { await app.close(); }
});
