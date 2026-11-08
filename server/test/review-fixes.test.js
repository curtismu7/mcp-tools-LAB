// Regression tests for the independent review of the proxy-next branch (OAuth, one-URL proxy, stdio stream).
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeAll, listen, readBody, signIn, world } from './fixtures/oauthWorld.js';
import { startApp } from './helpers.js';
import { createOAuth, isPingHost } from '../src/oauth.js';

const T = { timeout: 30_000 };
afterEach(closeAll);
const STDIO = fileURLToPath(new URL('./fixtures/stdioServer.mjs', import.meta.url));
const conn = (app, url, extra = {}) => app.call('POST', '/api/connections', { transport: 'http', url, ...extra }).then((r) => r.json.connection.id);
const h = (token) => ({ Connection: 'close', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

test('Ping hosts: a trailing dot is the same host, and every endpoint is checked, not only the issuer', T, async () => {
  for (const host of ['auth.pingidentity.com.', 'x.ping-devops.com.', 'AUTH.PINGONE.COM']) assert.ok(isPingHost(host), host);
  const w = await world({ authEndpoint: 'https://auth.pingone.com/env/as/authorize' }); // a non-Ping issuer fronting a Ping endpoint
  const app = await startApp();
  try {
    const id = await conn(app, w.mcp);
    const d = await app.call('GET', `/api/connections/${id}/oauth`);
    assert.equal(d.status, 400);
    assert.equal(d.json.error, 'oauth_ping_refused');
    assert.equal((await app.call('POST', `/api/connections/${id}/oauth/start`, {})).json.error, 'oauth_ping_refused');
  } finally { await app.close(); }
});

test('iss: two iss values are refused; when the server says it sends iss, a callback without one is refused', T, async () => {
  const w = await world({ lax: true });
  const app = await startApp();
  try {
    const id = await conn(app, w.mcp);
    const start = await app.call('POST', `/api/connections/${id}/oauth/start`, {});
    const back = new URL((await fetch(start.json.authorizeUrl, { redirect: 'manual' })).headers.get('location'));
    back.searchParams.append('iss', 'http://127.0.0.1:9/evil'); // a second iss next to the right one
    const two = await fetch(back, { headers: { Connection: 'close' } });
    assert.equal(two.status, 400);
    assert.match(await two.text(), /more than one iss/);
  } finally { await app.close(); }
  const adv = await world({ issParameter: true, noIss: true });
  const app2 = await startApp();
  try {
    const id = await conn(app2, adv.mcp);
    const r = await signIn(app2, id);
    assert.equal(r.cb.status, 400); assert.match(r.text, /says it sends iss/);
    assert.equal((await app2.call('GET', `/api/connections/${id}/oauth`)).json.signedIn, false);
  } finally { await app2.close(); }
});

test('a state is single use (even when the authorization server would accept the code again)', T, async () => {
  const w = await world({ lax: true });
  const app = await startApp();
  try {
    const id = await conn(app, w.mcp);
    const r = await signIn(app, id);
    assert.equal(r.cb.status, 200);
    assert.equal((await fetch(r.cb.url, { headers: { Connection: 'close' } })).status, 400);
    assert.equal(w.st.tokenCalls.filter((c) => c.grant_type === 'authorization_code').length, 1, 'the second callback never reached the token endpoint');
  } finally { await app.close(); }
});

test('a state expires after 10 minutes', T, async () => {
  const w = await world();
  let t = 1_000_000;
  const oauth = createOAuth({ now: () => t });
  const c = { id: 'c1', url: w.mcp };
  const s = await oauth.start(c, { redirectUri: 'http://127.0.0.1:1/api/oauth/callback' });
  const to = await fetch(s.authorizeUrl, { redirect: 'manual' });
  const cb = new URL(to.headers.get('location'));
  t += 10 * 60 * 1000 + 1;
  await assert.rejects(oauth.callback(Object.fromEntries(cb.searchParams)), /expired/);
  assert.equal(w.st.tokenCalls.length, 0);
});

test('metadata URLs: http for a non-loopback host is refused, a redirect is not followed', T, async () => {
  const hit = { n: 0 };
  const target = await listen((_req, res) => { hit.n += 1; res.writeHead(200).end('{}'); });
  const redirecting = await listen((req, res) => { if (req.url.includes('well-known')) return res.writeHead(302, { location: target }).end(); res.writeHead(401).end(); });
  const prm = await listen((req, res) => {
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ authorization_servers: ['http://auth.example.test'] }));
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${prm}/.well-known/oauth-protected-resource"` }).end();
  });
  const app = await startApp();
  try {
    const id = await conn(app, `${prm}/mcp`);
    const r = await app.call('GET', `/api/connections/${id}/oauth`);
    assert.equal(r.status, 400); assert.match(r.json.message, /must be https/);
    const w = await world();
    // the protected-resource metadata redirects somewhere else: not followed
    const redir = await listen((req, res) => {
      if (req.url.startsWith('/.well-known/oauth-protected-resource')) return res.writeHead(302, { location: `${target}/prm` }).end();
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
    });
    const id2 = await conn(app, `${redir}/mcp`);
    assert.equal((await app.call('GET', `/api/connections/${id2}/oauth`)).json.error, 'oauth_no_metadata');
    assert.equal(hit.n, 0, 'the redirect target was never fetched');
    void redirecting; void w;
  } finally { await app.close(); }
});

test('a mock-only copy refuses the OAuth callback too', T, async () => {
  const app = await startApp({ env: { MOCK_ONLY: '1' } });
  try { assert.equal((await fetch(`${app.origin}/api/oauth/callback?code=x&state=y`, { headers: { Connection: 'close' } })).status, 403); } finally { await app.close(); }
});

test('delete and Reset forget a sign-in (the sign-in store itself, not a new id)', T, async () => {
  const w = await world();
  const app = await startApp();
  try {
    const a = await conn(app, w.mcp);
    await signIn(app, a);
    assert.equal(app.app.locals.oauth.status(a).signedIn, true);
    await app.call('DELETE', `/api/connections/${a}`);
    assert.equal(app.app.locals.oauth.status(a).signedIn, false);
    const b = await conn(app, w.mcp);
    await signIn(app, b);
    assert.equal(app.app.locals.oauth.status(b).signedIn, true);
    await app.call('POST', '/api/reset');
    assert.equal(app.app.locals.oauth.status(b).signedIn, false);
  } finally { await app.close(); }
});

test('concurrent calls on an expiring token make one refresh (a rotating refresh token is used once)', T, async () => {
  const w = await world({ expiresIn: 1 });
  const app = await startApp();
  try {
    const id = await conn(app, w.mcp);
    await signIn(app, id);
    const before = w.st.tokenCalls.length;
    await Promise.all([app.app.locals.oauth.fresh(id), app.app.locals.oauth.fresh(id), app.app.locals.oauth.fresh(id)]);
    assert.equal(w.st.tokenCalls.slice(before).filter((c) => c.grant_type === 'refresh_token').length, 1);
  } finally { await app.close(); }
});

test('a token refreshed during a proxied call is scrubbed from the reply and the log', T, async () => {
  const w = await world({ expiresIn: 1 });
  const app = await startApp();
  try {
    const id = await conn(app, w.mcp, { label: 'Protected Server' });
    await signIn(app, id);
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const init = await fetch(`${app.origin}/proxy/mcp/${id}`, { method: 'POST', headers: h(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    await init.text();
    const call = await fetch(`${app.origin}/proxy/mcp/${id}`, { method: 'POST', headers: h(token), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } }) });
    const text = await call.text();
    assert.ok(!/access-secret-/.test(text), `client got: ${text.slice(0, 120)}`);
    assert.match(text, /\[redacted\]/);
    const flows = (await app.call('GET', '/api/proxy/flows')).json.flows;
    const logged = (await Promise.all(flows.map((f) => app.call('GET', `/api/proxy/flows/${f.id}`)))).map((r) => r.text).join('\n');
    assert.ok(!/access-secret-/.test(logged), 'no token in the flow log');
    // and through the one-URL route (the member's alias is the slug of its label)
    const agg = await fetch(`${app.origin}/proxy/mcp/`, { method: 'POST', headers: h(token), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'protected-server__x', arguments: {} } }) });
    const aggText = await agg.text();
    assert.ok(!/access-secret-/.test(aggText), `aggregate reply: ${aggText.slice(0, 100)}`);
  } finally { await app.close(); }
});

// ---- stdio stream ----------------------------------------------------------------------------------------------
async function stdioApp(env = {}) {
  const app = await startApp();
  const id = (await app.call('POST', '/api/connections', { transport: 'stdio', command: process.execPath, args: [STDIO], env: { STDIO_TEST_SECRET: 'stdio-secret-value-77', ...env }, label: 'stdio fake' })).json.connection.id;
  await app.call('POST', '/api/mode', { source: 'real' });
  const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
  const url = `${app.origin}/proxy/mcp/${id}`;
  const send = (body) => fetch(url, { method: 'POST', headers: h(token), body: JSON.stringify(body) });
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const open = async () => { const r = await fetch(url, { headers: { Connection: 'close', Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } }); return { r, reader: r.body.getReader() }; };
  // Reads until the stream ends (true) or the time is up ('still open'): the first chunk is only the opening comment.
  const ended = async (reader, ms = 4000) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      const x = await Promise.race([reader.read().catch(() => ({ done: true })), new Promise((res) => setTimeout(() => res({ wait: true }), 300))]);
      if (x.done) return true;
    }
    return 'still open';
  };
  return { app, id, token, send, open, ended };
}

test('stdio stream: closed when the proxy is turned off and when the connection is deleted; the listener goes away', T, async () => {
  const s = await stdioApp();
  try {
    const client = s.app.app.locals.manager.client(s.id);
    const a = await s.open();
    assert.equal(client.listenerCount(), 1);
    await s.app.call('POST', '/api/proxy', { enabled: false });
    assert.equal(await s.ended(a.reader), true, 'ended after the proxy was turned off');
    assert.equal(client.listenerCount(), 0, 'the listener was removed');
    const { token } = (await s.app.call('POST', '/api/proxy', { enabled: true })).json;
    const r = await fetch(`${s.app.origin}/proxy/mcp/${s.id}`, { headers: { Connection: 'close', Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    const reader = r.body.getReader();
    await s.app.call('DELETE', `/api/connections/${s.id}`);
    assert.equal(await s.ended(reader), true, 'ended after the connection was deleted');
  } finally { await s.app.close(); }
});

test('stdio stream: the saved env secret is scrubbed from streamed messages', T, async () => {
  const s = await stdioApp();
  try {
    const { r, reader } = await s.open();
    await s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'leak', arguments: {} } });
    const dec = new TextDecoder(); let text = '';
    for (let i = 0; i < 20 && !text.includes('env:'); i += 1) { const x = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({}), 300))]); if (x.value) text += dec.decode(x.value); }
    assert.match(text, /env:\[redacted\]/);
    assert.ok(!text.includes('stdio-secret-value-77'));
    reader.cancel(); void r;
  } finally { await s.app.close(); }
});

test('stdio: only answers to requests the server sent, only notifications/*, and only the JSON-RPC fields are forwarded', T, async () => {
  const s = await stdioApp();
  try {
    assert.equal((await s.send({ jsonrpc: '2.0', id: 999, result: { x: 1 } })).status, 400, 'an unsolicited answer');
    assert.equal((await s.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ask' } })).status, 400, 'a non-notification without an id');
    assert.equal((await s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 }, evil: 'x' })).status, 202);
    const { reader } = await s.open();
    const call = s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: {} } });
    await new Promise((r) => setTimeout(r, 400)); // the server's roots/list request reaches the stream
    const ok = await s.send({ jsonrpc: '2.0', id: 's-1', result: { roots: [] }, smuggled: { method: 'tools/call' } });
    assert.equal(ok.status, 202);
    assert.equal((await (await call).json()).result.content[0].text, 'asked');
    assert.equal((await s.send({ jsonrpc: '2.0', id: 's-1', result: { roots: [] } })).status, 400, 'an id is answered once');
    reader.cancel();
  } finally { await s.app.close(); }
});

// ---- one URL for all -----------------------------------------------------------------------------------------------
test('one URL: equal labels get unique aliases; a tool whose own name has __ is routed whole; member secrets are scrubbed', T, async () => {
  const seen = [];
  const mk = (toolName, echo) => listen(async (req, res) => {
    const msg = JSON.parse((await readBody(req)) || '{}');
    seen.push(msg.method === 'tools/call' ? msg.params.name : msg.method);
    if (msg.id === undefined) return res.writeHead(202).end();
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'm', version: '1' }, capabilities: {} }
      : msg.method === 'tools/list' ? { tools: [{ name: toolName, description: 'd', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: `${echo ? req.headers.authorization : 'ok'}` }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  const u1 = await mk('one', false); const u2 = await mk('a__b', true);
  const app = await startApp();
  try {
    await conn(app, `${u1}/mcp`, { label: 'Same Name' });
    await conn(app, `${u2}/mcp`, { label: 'Same Name', token: 'Bearer member-secret-9876', authHeader: 'Authorization' });
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const rpc = (body) => fetch(`${app.origin}/proxy/mcp/`, { method: 'POST', headers: h(token), body: JSON.stringify(body) }).then((r) => r.json());
    const names = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.ok(names.includes('same-name__one') && names.includes('same-name-2__a__b'), names.join(','));
    const echo = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'same-name-2__a__b', arguments: {} } });
    assert.equal(seen.at(-1), 'a__b', 'the member got its own tool name, split at the first __ only');
    assert.ok(!JSON.stringify(echo).includes('member-secret-9876'), 'the member credential is scrubbed from the reply');
    assert.match(JSON.stringify(echo), /\[redacted\]/);
  } finally { await app.close(); }
});
