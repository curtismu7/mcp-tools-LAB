// Real mode of the entitled-listing page, against a stub gateway on a loopback test port. The stub copies the caller's
// key into its refusal text on purpose, so these tests prove the key never reaches a response.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { readRefusal, realConfig } from '../src/gateway/real.js';
import { startApp, TEST_PORTS } from './helpers.js';

const T = { timeout: 60_000 };
// Fake keys, built from parts so no real-looking secret sits in the source.
const KEY_A = ['lab', 'analyst', 'key', '0123456789'].join('-');
const KEY_B = ['lab', 'guest', 'key', '9876543210'].join('-');

// Apps: full lists three tools for A and one for B; limited lists one; none refuses at initialize.
const LISTS = { full: { [KEY_A]: ['crm__find', 'crm__export', 'wiki__search'], [KEY_B]: ['wiki__search'] }, limited: { [KEY_A]: ['crm__find'], [KEY_B]: ['crm__find'] } };

async function startStub() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const key = (req.headers.authorization || '').replace(/^Bearer /, '');
      const app = req.url.split('/')[1];
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      const msg = JSON.parse(body || '{}');
      seen.push({ app, method: msg.method, name: msg.params?.name });
      const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...o })); };
      if (![KEY_A, KEY_B].includes(key)) { res.writeHead(401).end(`unauthorized ${key}`); return; }
      if (app === 'none') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'request refused by policy' } })); return; }
      if (msg.method === 'initialize') return reply({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub' } } });
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      if (msg.method === 'tools/list') return reply({ result: { tools: LISTS[app][key].map((name) => ({ name, description: `tool ${name}` })) } });
      if (msg.method === 'tools/call') return reply({ error: { code: -32600, message: `"${msg.params.name}" is not exposed by this aggregate (caller ${key})` } });
      return reply({ error: { code: -32601, message: 'no' } });
    });
  });
  for (const port of [...TEST_PORTS].reverse()) {
    try { await new Promise((ok, no) => { srv.once('error', no); srv.listen(port, '127.0.0.1', ok); }); return { port, seen, close: () => new Promise((r) => srv.close(r)) }; } catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  throw new Error('no free test port');
}

async function withReal(extra, fn) {
  const stub = await startStub();
  const env = { MCP_TOOLS_GW_URL: `http://127.0.0.1:${stub.port}`, MCP_TOOLS_GW_APPS: 'full,limited,none', MCP_TOOLS_GW_KEY_ANALYST: KEY_A, MCP_TOOLS_GW_KEY_GUEST: KEY_B, ...extra };
  const app = await startApp({ env });
  try { return await fn(app, stub); } finally { await app.close(); await stub.close(); }
}
const noKeys = (r) => { assert.ok(!r.text.includes(KEY_A) && !r.text.includes(KEY_B), 'a key reached the response'); return r; };
const real = (app) => app.call('POST', '/api/mode', { source: 'real' });

test('GET /api/gateway/real names apps and callers, never a key', T, async () => {
  await withReal({}, async (app) => {
    const r = noKeys(await app.call('GET', '/api/gateway/real'));
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.mode, 'mock');
    assert.deepEqual(r.json.apps, ['full', 'limited', 'none']);
    assert.deepEqual(r.json.callers, [{ id: 'analyst', label: 'Analyst' }, { id: 'guest', label: 'Guest' }]);
  });
});

test('Real routes refuse while the header is on Mock, and nothing is sent', T, async () => {
  await withReal({}, async (app, stub) => {
    const r = await app.call('POST', '/api/gateway/real/list', { app: 'full', caller: 'analyst' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'mock_mode');
    assert.equal(stub.seen.length, 0);
  });
});

test('list: each app and caller gets the gateway\'s own listing; a refusal is read as a check', T, async () => {
  await withReal({}, async (app) => {
    await real(app);
    const list = async (a, c) => noKeys(await app.call('POST', '/api/gateway/real/list', { app: a, caller: c })).json;
    assert.deepEqual((await list('full', 'analyst')).tools.map((t) => t.name), ['crm__find', 'crm__export', 'wiki__search']);
    assert.deepEqual((await list('full', 'guest')).tools.map((t) => t.name), ['wiki__search']);
    assert.deepEqual((await list('limited', 'analyst')).tools.map((t) => t.name), ['crm__find']);
    const none = await list('none', 'analyst');
    assert.equal(none.ok, false);
    assert.equal(none.refusal.layer, 'policy');
    assert.match(none.reading, /our reading/);
  });
});

test('call: a hidden name is sent and its refusal comes back scrubbed of the key', T, async () => {
  await withReal({}, async (app, stub) => {
    await real(app);
    const r = noKeys(await app.call('POST', '/api/gateway/real/call', { app: 'limited', caller: 'analyst', tool: 'crm__export', confirm: true }));
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.refusal.layer, 'tool-filter');
    assert.match(r.json.refusal.message, /\[redacted\]/);
    assert.ok(stub.seen.some((s) => s.method === 'tools/call' && s.name === 'crm__export'));
  });
});

test('call: a listed tool is never sent from this page; confirm, app, caller and name are checked', T, async () => {
  await withReal({}, async (app, stub) => {
    await real(app);
    const listed = await app.call('POST', '/api/gateway/real/call', { app: 'full', caller: 'analyst', tool: 'crm__find', confirm: true });
    assert.equal(listed.status, 409);
    assert.equal(listed.json.error, 'listed_tool');
    assert.ok(!stub.seen.some((s) => s.method === 'tools/call'));
    assert.equal((await app.call('POST', '/api/gateway/real/call', { app: 'full', caller: 'analyst', tool: 'crm__nope' })).status, 400);
    assert.equal((await app.call('POST', '/api/gateway/real/call', { app: 'other', caller: 'analyst', tool: 'x', confirm: true })).status, 400);
    assert.equal((await app.call('POST', '/api/gateway/real/list', { app: 'full', caller: 'nobody' })).status, 400);
    assert.equal((await app.call('POST', '/api/gateway/real/call', { app: 'full', caller: 'analyst', tool: 'bad name!', confirm: true })).status, 400);
    assert.equal((await app.call('POST', '/api/gateway/real/list', { app: 'full', caller: 'analyst', extra: 1 })).status, 400);
    assert.ok(!stub.seen.some((s) => s.method === 'tools/call'));
  });
});

test('not configured: Real says why; MOCK_ONLY=1 refuses Real', T, async () => {
  const app = await startApp({ env: {} });
  try {
    const r = await app.call('GET', '/api/gateway/real');
    assert.equal(r.json.available, false);
    assert.match(r.json.problem, /MCP_TOOLS_GW_URL/);
    await real(app);
    assert.equal((await app.call('POST', '/api/gateway/real/list', { app: 'x', caller: 'y' })).json.error, 'real_not_configured');
  } finally { await app.close(); }
  await withReal({ MOCK_ONLY: '1' }, async (app2, stub) => {
    const r = await app2.call('GET', '/api/gateway/real');
    assert.equal(r.json.available, false);
    assert.equal((await app2.call('POST', '/api/gateway/real/list', { app: 'full', caller: 'analyst' })).status, 409);
    assert.equal(stub.seen.length, 0);
  });
});

test('realConfig and readRefusal', () => {
  assert.equal(realConfig({ MCP_TOOLS_GW_URL: 'http://gw.example.invalid', MCP_TOOLS_GW_APPS: 'a', MCP_TOOLS_GW_KEY_X: 'k' }).ok, false);
  assert.equal(realConfig({ MCP_TOOLS_GW_URL: 'https://gw.example.invalid', MCP_TOOLS_GW_APPS: 'A B', MCP_TOOLS_GW_KEY_X: 'k' }).ok, false);
  assert.equal(realConfig({ MCP_TOOLS_GW_URL: 'https://gw.example.invalid', MCP_TOOLS_GW_APPS: 'a', MCP_TOOLS_GW_KEY_X: 'has space' }).ok, false);
  assert.equal(realConfig({ MCP_TOOLS_GW_URL: 'https://gw.example.invalid/x/y', MCP_TOOLS_GW_APPS: 'a,b', MCP_TOOLS_GW_KEY_X: 'k' }).origin, 'https://gw.example.invalid');
  assert.equal(readRefusal({ httpStatus: 401, message: 'MCP HTTP 401' }), 'key');
  assert.equal(readRefusal({ message: '"t" is not exposed by this aggregate' }), 'tool-filter');
  assert.equal(readRefusal({ httpStatus: 400, message: 'request refused by policy' }), 'policy');
  assert.equal(readRefusal({ message: 'connect m: failed to connect: Internal Server Error' }), 'unreachable');
  assert.equal(readRefusal({ message: 'something else' }), 'other');
});

test('realConfig carries the operator\'s version label, and drops one that is not a plain label', () => {
  const base = { MCP_TOOLS_GW_URL: 'https://gw.example.invalid', MCP_TOOLS_GW_APPS: 'a', MCP_TOOLS_GW_KEY_X: 'k' };
  assert.equal(realConfig({ ...base, MCP_TOOLS_GW_VERSION: 'v1.261106' }).version, 'v1.261106');
  assert.equal(realConfig(base).version, null);
  assert.equal(realConfig({ ...base, MCP_TOOLS_GW_VERSION: '<img src=x onerror=1>' }).version, null);
  assert.equal(realConfig({ ...base, MCP_TOOLS_GW_VERSION: 'v'.repeat(41) }).version, null);
});
