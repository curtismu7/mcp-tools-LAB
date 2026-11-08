// The one-URL proxy route (/proxy/mcp/): merged tools named <alias>__<tool>, routed calls, unreachable members reported.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { startFakeMcp as startFake } from './fixtures/fakeMcp.js';
import { startApp } from './helpers.js';

const T = { timeout: 20_000 };
const opened = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((s) => s.close())); });
const rpc = (app, token, body, path = '/proxy/mcp/') => fetch(`${app.origin}${path}`, { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('Mock: one URL lists both samples as <alias>__<tool> and routes a call to the right one', T, async () => {
  const app = await startApp();
  try {
    const v = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    assert.deepEqual(v.all, { id: '*', label: 'All servers (one URL)', transport: 'aggregate', path: '/proxy/mcp/' });
    const init = await rpc(app, v.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.json.result.serverInfo.name, 'mcp-tools-all-servers');
    const list = (await rpc(app, v.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result;
    const names = list.tools.map((t) => t.name);
    assert.ok(names.includes('sample-server-clean__get_time'), names.join(','));
    assert.ok(names.some((n) => n.startsWith('hostile-sample-server-poisoned__')), names.join(','));
    assert.equal(list._meta, undefined);
    const call = (await rpc(app, v.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sample-server-clean__add', arguments: { a: 1, b: 2 } } })).json;
    assert.match(call.result.content[0].text, /mock result for add/);
    const bad = (await rpc(app, v.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope__add' } })).json;
    assert.equal(bad.error.code, -32602);
    assert.equal((await rpc(app, v.token, { jsonrpc: '2.0', id: 5, method: 'resources/read', params: {} })).json.error.code, -32601);
    const flows = (await app.call('GET', '/api/proxy/flows')).json.flows;
    const f = flows.find((x) => x.rpcMethod === 'tools/call' && x.status === 200);
    assert.equal(f.route, 'mock-sample', 'a routed call is logged under its server');
    assert.equal(f.via, 'aggregate');
  } finally { await app.close(); }
});

test('Real: saved servers join; one that is down is reported in _meta, not dropped silently; guards still apply', T, async () => {
  const up = await startFake({}); opened.push(up);
  const down = await startFake({}); await down.close();
  const app = await startApp();
  try {
    await app.call('POST', '/api/connections', { transport: 'http', url: up.url, label: 'Up server' });
    await app.call('POST', '/api/connections', { transport: 'http', url: down.url, label: 'Down server' });
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const list = (await rpc(app, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result;
    assert.ok(list.tools.some((t) => t.name === 'up-server__get_time'));
    assert.deepEqual(list._meta['mcp-tools/unreachable'].map((u) => u.server), ['down-server']);
    const call = (await rpc(app, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'up-server__get_time', arguments: { tz: 'UTC' } } })).json;
    assert.match(call.result.content[0].text, /called get_time/);
    assert.deepEqual(up.seen.calls.at(-1), { name: 'get_time', arguments: { tz: 'UTC' } });
    assert.equal((await rpc(app, 'wrong', { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 401);
    await app.call('POST', '/api/mode', { source: 'mock' });
    const mock = (await rpc(app, token, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).json.result;
    assert.ok(!mock.tools.some((t) => t.name.startsWith('up-server__')), 'Mock never fans out to saved servers');
    assert.equal(up.seen.methods.filter((m) => m === 'tools/list').length, 1, 'only the Real listing reached the server');
  } finally { await app.close(); }
});

test('a sample saved as a connection (transport mock) is not offered twice in Real', T, async () => {
  const app = await startApp();
  try {
    await app.call('POST', '/api/connections', { transport: 'mock', fixture: 'sample' });
    await app.call('POST', '/api/mode', { source: 'real' });
    const v = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    assert.deepEqual(v.routes.map((r) => r.transport), ['mock', 'mock']);
    const names = (await rpc(app, v.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools.map((t) => t.name);
    assert.equal(names.filter((n) => n.endsWith('__get_time')).length, 1);
  } finally { await app.close(); }
});
