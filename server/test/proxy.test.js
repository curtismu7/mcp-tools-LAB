// Live proxy (/proxy/mcp/<id>) and its control API (/api/proxy). Each guard in server/src/proxy/router.js has a test here.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { startFakeMcp as startFake } from './fixtures/fakeMcp.js';
import { startApp } from './helpers.js';
import { estimateTokens } from '../src/proxy/tokens.js';
import { captureBody, createFlowLog, MAX_BODY } from '../src/proxy/flows.js';

const T = { timeout: 20_000 };
const opened = [];
async function startFakeMcp(o) { const s = await startFake(o); opened.push(s); return s; }
afterEach(async () => { await Promise.all(opened.splice(0).map((s) => s.close())); });
async function withApp(opts, fn) { const app = await startApp(opts); try { await fn(app); } finally { await app.close(); } }

const UPSTREAM = 'Bearer upstream-secret-value-123';
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } } };

// What an MCP client (no browser, so no Origin) sends to the proxy.
function agent(app, token) {
  return async (id, body, { method = 'POST', headers = {} } = {}) => {
    const h = { Connection: 'close', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(`${app.origin}/proxy/mcp/${encodeURIComponent(id)}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* SSE or empty */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}
async function enable(call) { const r = await call('POST', '/api/proxy', { enabled: true }); assert.equal(r.status, 200); return r.json; }

test('estimateTokens is characters / 4 rounded up; captureBody caps, scrubs and parses SSE', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens({ a: 1 }), 2); // {"a":1} = 7 chars
  const big = captureBody('x'.repeat(MAX_BODY + 10));
  assert.equal(big.truncated, true);
  assert.equal(big.bytes, MAX_BODY + 10);
  assert.equal(captureBody('{"t":"my-secret-x"}', { secrets: ['my-secret-x'] }).json.t, '[redacted]');
  assert.deepEqual(captureBody('event: message\ndata: {"id":1}\n\n', { contentType: 'text/event-stream' }).sse, [{ id: 1 }]);
  const log = createFlowLog({ max: 2 });
  log.add({}); log.add({}); log.add({});
  assert.deepEqual(log.list().map((f) => f.id), [2, 3]);
});

test('the proxy is off by default and the control API is same-origin only', T, async () => {
  await withApp({}, async (app) => {
    const v = await app.call('GET', '/api/proxy');
    assert.equal(v.json.enabled, false);
    assert.equal(v.json.token, null);
    assert.equal((await agent(app, 'anything')('mock-sample', INIT)).status, 503);
    assert.equal((await app.call('POST', '/api/proxy', { enabled: true }, { origin: null })).status, 403, 'no Origin');
    assert.equal((await app.call('POST', '/api/proxy', { enabled: true }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await app.call('POST', '/api/proxy', { enabled: 'yes' })).status, 400);
    assert.equal((await app.call('POST', '/api/proxy', { enabled: true, extra: 1 })).status, 400);
  });
});

test('every proxied request needs the current proxy token; a web page from another site is refused', T, async () => {
  await withApp({}, async (app) => {
    const { token } = await enable(app.call);
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await agent(app, null)('mock-sample', INIT)).status, 401);
    assert.equal((await agent(app, 'wrong')('mock-sample', INIT)).status, 401);
    const cross = await agent(app, token)('mock-sample', INIT, { headers: { Origin: 'http://evil.example' } });
    assert.equal(cross.status, 403);
    assert.equal(cross.headers.get('access-control-allow-origin'), null);
    assert.equal((await agent(app, token)('mock-sample', INIT)).status, 200);
    // off kills the token; on again mints a different one
    await app.call('POST', '/api/proxy', { enabled: false });
    assert.equal((await agent(app, token)('mock-sample', INIT)).status, 503);
    const again = await enable(app.call);
    assert.notEqual(again.token, token);
    assert.equal((await agent(app, token)('mock-sample', INIT)).status, 401);
  });
});

test('Mock mode: the built-in fixtures are bridged in-process; a saved server needs Real (409)', T, async () => {
  const fake = await startFakeMcp({});
  await withApp({}, async (app) => {
    const c = await app.call('POST', '/api/connections', { transport: 'http', url: fake.url, label: 'fake' });
    const { token, routes } = await enable(app.call);
    assert.deepEqual(routes.map((r) => r.id), ['mock-sample', 'mock-hostile'], 'Mock lists fixtures only');
    const send = agent(app, token);
    const init = await send('mock-sample', INIT);
    assert.equal(init.json.result.serverInfo.name, 'sample-fixture');
    assert.equal((await send('mock-sample', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await send('mock-hostile', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.json.result.tools.length > 0);
    assert.equal((await send('mock-sample', [INIT])).status, 400, 'no batches on a bridged route');
    assert.equal((await send('mock-sample', undefined, { method: 'GET' })).status, 405);
    const refused = await send(c.json.connection.id, INIT);
    assert.equal(refused.status, 409);
    assert.equal(fake.seen.methods.filter((m) => m === 'initialize').length, 1, 'only the connect test reached the fake server');
    assert.equal((await send('no-such-id', INIT)).status, 404);
  });
});

test('Real mode: http passthrough uses the saved upstream credential; neither token is forwarded or logged', T, async () => {
  const fake = await startFakeMcp({ token: UPSTREAM });
  await withApp({}, async (app) => {
    const c = await app.call('POST', '/api/connections', { transport: 'http', url: fake.url, label: 'fake', token: UPSTREAM });
    const id = c.json.connection.id;
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token, routes } = await enable(app.call);
    assert.ok(routes.some((r) => r.id === id && r.path === `/proxy/mcp/${id}`));
    const send = agent(app, token);
    const init = await send(id, INIT);
    assert.equal(init.status, 200);
    const sid = init.headers.get('mcp-session-id');
    assert.match(sid, /^sess-/, 'session id is passed back to the client');
    await send(id, { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'Mcp-Session-Id': sid } });
    const list = await send(id, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers: { 'Mcp-Session-Id': sid } });
    assert.equal(list.json.result.tools[0].name, 'get_time');
    const call = await send(id, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_time', arguments: { tz: 'UTC' } } }, { headers: { 'Mcp-Session-Id': sid } });
    assert.match(call.json.result.content[0].text, /called get_time/);
    assert.ok(fake.seen.auth.slice(1).every((a) => a === UPSTREAM), 'upstream saw the saved credential, never the proxy token');
    assert.ok(!fake.seen.auth.some((a) => String(a).includes(token)));

    const flows = (await app.call('GET', '/api/proxy/flows')).json.flows;
    assert.deepEqual(flows.map((f) => f.rpcMethod), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    const f = flows.at(-1);
    assert.equal(f.via, 'passthrough');
    assert.equal(f.status, 200);
    assert.equal(f.open, false);
    assert.ok(f.ms >= 0 && f.responseBytes > 0);
    const detail = (await app.call('GET', `/api/proxy/flows/${f.id}`)).json.flow;
    assert.deepEqual(detail.request.body.json.params, { name: 'get_time', arguments: { tz: 'UTC' } });
    assert.ok(detail.response.body.tokens > 0);
    const all = JSON.stringify(await Promise.all(flows.map((x) => app.call('GET', `/api/proxy/flows/${x.id}`).then((r) => r.json))));
    assert.ok(!all.includes('upstream-secret-value-123'), 'saved credential is not in the log');
    assert.ok(!all.includes(token), 'proxy token is not in the log');
    // later Mock mode refuses the saved route again
    await app.call('POST', '/api/mode', { source: 'mock' });
    assert.equal((await send(id, INIT)).status, 409);
  });
});

test('an upstream that echoes the credential back: the client gets the raw passthrough, the log is scrubbed', T, async () => {
  const fake = await startFakeMcp({ token: 'Bearer expected-other' }); // 401 body echoes the header it got
  await withApp({}, async (app) => {
    const c = await app.call('POST', '/api/connections', { transport: 'http', url: fake.url, token: UPSTREAM });
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = await enable(app.call);
    const r = await agent(app, token)(c.json.connection.id, INIT);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), null, 'no OAuth challenge is relayed');
    const f = (await app.call('GET', '/api/proxy/flows')).json.flows.at(-1);
    assert.match(f.error, /refused the saved credential/);
    const d = (await app.call('GET', `/api/proxy/flows/${f.id}`)).text;
    assert.ok(!d.includes('upstream-secret-value-123'));
    assert.match(d, /\[redacted\]/);
  });
});

test('SSE replies stream through and are logged as messages', T, async () => {
  const fake = await startFakeMcp({ sse: true });
  await withApp({}, async (app) => {
    const c = await app.call('POST', '/api/connections', { transport: 'http', url: fake.url });
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = await enable(app.call);
    const r = await agent(app, token)(c.json.connection.id, INIT);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    assert.match(r.text, /data: .*sample|data: .*fake/);
    const f = (await app.call('GET', '/api/proxy/flows')).json.flows.at(-1);
    const d = (await app.call('GET', `/api/proxy/flows/${f.id}`)).json.flow;
    assert.equal(d.response.body.sse[0].result.serverInfo.name, 'fake');
  });
});

test('Reset turns the proxy off, kills the token and clears the flow log; DELETE clears the log only', T, async () => {
  await withApp({}, async (app) => {
    const { token } = await enable(app.call);
    await agent(app, token)('mock-sample', INIT);
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.length, 1);
    assert.equal((await app.call('DELETE', '/api/proxy/flows')).status, 204);
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.length, 0);
    assert.equal((await app.call('GET', '/api/proxy')).json.enabled, true);
    await agent(app, token)('mock-sample', INIT);
    await app.call('POST', '/api/reset');
    const v = (await app.call('GET', '/api/proxy')).json;
    assert.equal(v.enabled, false);
    assert.equal(v.token, null);
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.length, 0);
    assert.equal((await agent(app, token)('mock-sample', INIT)).status, 503);
  });
});

test('a MOCK_ONLY copy proxies the fixtures only', T, async () => {
  await withApp({ env: { MOCK_ONLY: '1' } }, async (app) => {
    const { token, routes } = await enable(app.call);
    assert.deepEqual(routes.map((r) => r.id), ['mock-sample', 'mock-hostile']);
    assert.equal((await agent(app, token)('mock-sample', INIT)).status, 200);
  });
});
