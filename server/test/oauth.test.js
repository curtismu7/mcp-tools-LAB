// Third-party OAuth sign-in (rule-16 exception): a fake authorization server and a fake protected MCP server, both on
// loopback. The "browser" is this test following the authorize redirect.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { closeAll, signIn, world } from './fixtures/oauthWorld.js';
import { startApp } from './helpers.js';
import { isPingHost, parseChallenge } from '../src/oauth.js';

const T = { timeout: 20_000 };
afterEach(closeAll);
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
