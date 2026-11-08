// Two follow-ups to "a Bearer 401 on a call offers the sign-in":
//  1. a call that only goes through the live proxy (per-server URL or the one URL) brings up the sign-in card too;
//  2. a 403 that names the scopes a call needs, for a signed-in user, says which scope is missing.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { closeAll, signIn, world } from './fixtures/oauthWorld.js';
import { startApp } from './helpers.js';
import { parseChallenge } from '../src/oauth.js';

const T = { timeout: 20_000 };
afterEach(closeAll);

const callBody = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
const viaProxy = (app, token, path, body = callBody) => fetch(`${app.origin}${path}`, { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
async function setup(opts, conn = {}) {
  const w = await world(opts);
  const app = await startApp();
  await app.call('POST', '/api/mode', { source: 'real' });
  const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp, label: 'lazy', ...conn })).json.connection.id;
  const token = (await app.call('POST', '/api/proxy', { enabled: true })).json.token;
  return { w, app, id, token };
}
const required = async (app, id, want, ms = 4000) => { // the note is made after the reply is sent: wait for it
  const until = Date.now() + ms; let r;
  do { r = (await app.call('GET', `/api/connections/${id}/oauth`)).json.required; if (r === want) return r; await new Promise((ok) => setTimeout(ok, 100)); } while (Date.now() < until);
  return r;
};

test('proxy, per-server URL: a refused call reaches the agent as 401 and the Server page learns the server wants a token', T, async () => {
  const { app, id, token } = await setup({ lazy: true });
  try {
    assert.equal((await app.call('GET', `/api/connections/${id}/oauth`)).json.required, false);
    const r = await viaProxy(app, token, `/proxy/mcp/${id}`);
    assert.equal(r.status, 401, 'the agent still gets the upstream 401');
    assert.equal(await required(app, id, true), true);
  } finally { await app.close(); }
});

test('proxy, one URL: a refused routed call brings up the sign-in too', T, async () => {
  const { app, id, token } = await setup({ lazy: true });
  try {
    const r = await (await viaProxy(app, token, '/proxy/mcp/', { ...callBody, params: { name: 'lazy__whoami', arguments: {} } })).json();
    assert.ok(r.error, 'the agent gets a JSON-RPC error'); assert.match(r.error.message, /401/);
    assert.equal(await required(app, id, true), true);
  } finally { await app.close(); }
});

test('proxy: nothing is remembered when a saved token was refused or the 401 is not a Bearer challenge', T, async () => {
  const saved = await setup({ lazy: true }, { token: 'Bearer saved-but-wrong' });
  try {
    assert.equal((await viaProxy(saved.app, saved.token, `/proxy/mcp/${saved.id}`)).status, 401);
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal((await saved.app.call('GET', `/api/connections/${saved.id}/oauth`)).json.required, false);
  } finally { await saved.app.close(); }
  const basic = await setup({ lazy: true, challenge: 'Basic realm="x"' });
  try {
    assert.equal((await viaProxy(basic.app, basic.token, `/proxy/mcp/${basic.id}`)).status, 401);
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal((await basic.app.call('GET', `/api/connections/${basic.id}/oauth`)).json.required, false);
  } finally { await basic.app.close(); }
});

const callOf = async (app, id) => {
  const pre = await app.call('POST', `/api/connections/${id}/call/preview`, { tool: 'whoami', arguments: {} });
  return app.call('POST', `/api/connections/${id}/call`, { tool: 'whoami', arguments: {}, confirm: true, argsHash: pre.json.argsHash });
};
async function signedIn(opts) {
  const w = await world({ lazy: true, ...opts });
  const app = await startApp();
  const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
  assert.equal((await callOf(app, id)).json.error, 'mcp_signin_needed');
  await signIn(app, id);
  return { w, app, id };
}

test('403 with the scopes a call needs (JSON-RPC data): names the missing scope and what the sign-in has', T, async () => {
  const { app, id } = await signedIn({ needScope: ['invest:read', 'tools:read'] });
  try {
    const r = await callOf(app, id);
    assert.equal(r.status, 403); assert.equal(r.json.error, 'mcp_scope_needed');
    assert.match(r.json.message, /needs the scope invest:read, which this sign-in does not have \(it has: tools:read\)/);
    assert.match(r.json.message, /MCPTOOLS_P1_SCOPES/); assert.match(r.json.message, /only when the server itself lists it/);
    assert.ok(!r.json.message.includes('tools:read, '), 'a scope the sign-in already has is not listed as missing');
  } finally { await app.close(); }
});

test('403 with an RFC 6750 insufficient_scope challenge (quoted or bare error) names the scopes too', T, async () => {
  for (const scopeHeader of ['Bearer error="insufficient_scope", scope="a:b c.d"', 'Bearer error=insufficient_scope, scope="a:b c.d"']) {
    const { app, id } = await signedIn({ needScope: [], scopeHeader });
    try {
      const r = await callOf(app, id);
      assert.equal(r.json.error, 'mcp_scope_needed', scopeHeader); assert.match(r.json.message, /scopes a:b c\.d,/);
    } finally { await app.close(); }
  }
  assert.deepEqual(parseChallenge('Bearer error=insufficient_scope, scope="a b", realm="r"'), { error: 'insufficient_scope', scope: 'a b', realm: 'r' });
});

test('scope names are plain text only, at most 10, and a 403 is ordinary when nothing usable or nothing missing remains', T, async () => {
  const { app, id } = await signedIn({ needScope: ['<script>alert(1)</script>', 'x'.repeat(200), 'ok:scope', 'two words', { a: 1 }, 'line\nbreak'] });
  try {
    const r = await callOf(app, id);
    assert.equal(r.json.error, 'mcp_scope_needed'); assert.match(r.json.message, /needs the scope ok:scope, which/);
    assert.ok(!/script|xxxx|two words|break/.test(r.json.message), r.json.message);
  } finally { await app.close(); }
  const none = await signedIn({ needScope: ['<b>', 'a b c'.repeat(40)] });
  try { assert.equal((await callOf(none.app, none.id)).json.error, 'mcp_http_error', 'nothing usable: the original error'); } finally { await none.app.close(); }
  const have = await signedIn({ needScope: ['tools:read'] });
  try { assert.equal((await callOf(have.app, have.id)).json.error, 'mcp_http_error', 'the sign-in already holds it: the original error'); } finally { await have.app.close(); }
  const many = await signedIn({ needScope: Array.from({ length: 30 }, (_, i) => `s${i}`) });
  try { const m = (await callOf(many.app, many.id)).json.message; assert.match(m, /scopes s0 s1 s2 s3 s4 s5 s6 s7 s8 s9,/); assert.ok(!m.includes('s10'), 'at most 10'); } finally { await many.app.close(); }
});

test('403 without a sign-in (no credential in use) stays an ordinary error', T, async () => {
  const w = await world({ lazy: true, needScope: ['invest:read'] });
  const app = await startApp();
  try {
    w.st.open = true; // the server needs no token at all
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: w.mcp })).json.connection.id;
    const r = await callOf(app, id);
    assert.equal(r.json.error, 'mcp_http_error'); assert.match(r.json.message, /403/);
  } finally { await app.close(); }
});

test('proxy: only a 401 counts, and many refused calls cost one discovery', T, async () => {
  const odd = await setup({ lazy: true, unauthStatus: 500 });
  try {
    assert.equal((await viaProxy(odd.app, odd.token, `/proxy/mcp/${odd.id}`)).status, 500);
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal((await odd.app.call('GET', `/api/connections/${odd.id}/oauth`)).json.required, false, 'a 500 with a Bearer challenge is not a sign-in request');
  } finally { await odd.app.close(); }
  const { w, app, id, token } = await setup({ lazy: true });
  try {
    const seen = () => w.st.mcpAuth.length;
    const before = seen();
    await Promise.all(Array.from({ length: 12 }, () => viaProxy(app, token, `/proxy/mcp/${id}`).then((r) => r.text())));
    assert.equal(await required(app, id, true), true);
    await new Promise((ok) => setTimeout(ok, 300));
    // 12 relayed calls + at most one discovery probe (and none of the 12 triggered its own)
    assert.ok(seen() - before <= 12 + 2, `server hits: ${seen() - before}`);
  } finally { await app.close(); }
});

test('403 details: a header without insufficient_scope does not count, the body still can, scope names are exact, and the "has" list is plain text', T, async () => {
  const a = await signedIn({ needScope: ['x:y'], scopeHeader: 'Bearer scope="x:y"' }); // header names a scope but not the error; body names it too
  try { assert.equal((await callOf(a.app, a.id)).json.error, 'mcp_scope_needed', 'the body is read when the header is not an insufficient_scope challenge'); } finally { await a.app.close(); }
  const b = await signedIn({ needScope: [], scopeHeader: 'Bearer scope="x:y"' }); // header alone, no insufficient_scope: not a scope refusal
  try { assert.equal((await callOf(b.app, b.id)).json.error, 'mcp_http_error'); } finally { await b.app.close(); }
  const c = await signedIn({ needScope: ['Tools:Read'] }); // scopes are case-sensitive: tools:read is held, Tools:Read is not
  try { const r = await callOf(c.app, c.id); assert.equal(r.json.error, 'mcp_scope_needed'); assert.match(r.json.message, /needs the scope Tools:Read,/); } finally { await c.app.close(); }
  const d = await signedIn({ needScope: ['k', 'k', 'k2'] });
  try { assert.match((await callOf(d.app, d.id)).json.message, /needs the scopes k k2,/, 'duplicates are listed once'); } finally { await d.app.close(); }
  const e = await signedIn({ needScope: ['invest:read'], tokenScope: 'a‮b <img src=x onerror=alert(1)>\nSECOND tools:read' });
  try {
    const r = await callOf(e.app, e.id);
    assert.equal(r.json.error, 'mcp_scope_needed'); assert.match(r.json.message, /\(it has: SECOND tools:read\)/, 'plain words stay, markup and bidi do not');
    assert.ok(!/img|onerror|\u202e|\n/.test(r.json.message), r.json.message);
  } finally { await e.app.close(); }
});
