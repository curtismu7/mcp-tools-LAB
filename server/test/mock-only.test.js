// MOCK_ONLY=1: the hosted-mock switch. Refusals are server-side (403 mock_only), the only servers are in-process
// fixtures, and the process makes no outbound connection at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { startFakeMcp } from './fixtures/fakeMcp.js';
import { startApp } from './helpers.js';

const T = { timeout: 20_000 };
const REFUSAL = { error: 'mock_only', message: 'Disabled in the hosted mock.' };
const ON = { MOCK_ONLY: '1' };

async function withApp(opts, fn) {
  const app = await startApp(opts);
  try { await fn(app); } finally { await app.close(); }
}

// A tiny network guard: records every socket connect() in this process. The only legal target is the app itself.
function watchConnects() {
  const seen = [];
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patched(...args) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    seen.push(typeof o === 'object' && o ? `${o.host || o.path || 'localhost'}:${o.port ?? ''}` : `${args[1] || 'localhost'}:${o}`);
    return orig.apply(this, args);
  };
  return { seen, stop: () => { net.Socket.prototype.connect = orig; } };
}

// A server that counts hits, to prove a refused URL was never contacted.
function trap() {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; res.writeHead(302, { location: 'http://169.254.169.254/' }).end(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, hits: () => hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

test('MOCK_ONLY=1 refuses arbitrary URLs with 403 mock_only and never contacts them', T, async () => {
  const t = await trap();
  try {
    await withApp({ env: ON }, async ({ call }) => {
      for (const url of ['http://169.254.169.254/', 'http://127.0.0.1:22/', `http://127.0.0.1:${t.port}/redirect`, 'http://localhost:1/mcp', 'https://svc.example/mcp']) {
        const r = await call('POST', '/api/connections', { transport: 'http', label: 'x', url });
        assert.equal(r.status, 403, url);
        assert.deepEqual(r.json, REFUSAL);
      }
      assert.equal(t.hits(), 0);
    });
  } finally { await t.close(); }
});

test('MOCK_ONLY=1 also refuses stdio, pingone, tokens, env, extra fields and unknown fixtures', T, async () => {
  await withApp({ env: { ...ON, MCPTOOLS_PINGONE: '1' } }, async ({ call }) => {
    for (const body of [
      { transport: 'stdio', command: 'node', args: ['-e', '1'] },
      { transport: 'pingone' },
      { transport: 'mock', fixture: 'sample', url: 'http://169.254.169.254/' },
      { transport: 'mock', fixture: 'sample', token: 'secret' },
      { transport: 'mock', fixture: '../../etc/passwd' },
      { transport: 'http', url: 'http://x/', token: 't' },
      {},
    ]) {
      const r = await call('POST', '/api/connections', body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.deepEqual(r.json, REFUSAL);
    }
    for (const p of ['/api/pingone/status', '/api/pingone/callback']) assert.equal((await call('GET', p)).status, 403);
    assert.equal((await call('POST', '/api/pingone/login', {})).status, 403);
    const cfg = (await call('GET', '/api/config')).json;
    assert.equal(cfg.mockOnly, true);
    assert.equal(cfg.stdio, false);
    assert.equal(cfg.pingone.enabled, false);
  });
});

test('MOCK_ONLY=1 connects, lists, scans and previews against the built-in fixtures with zero outbound connections', T, async () => {
  const dir = fs.mkdtempSync(`${fs.realpathSync(process.env.TMPDIR || '/tmp')}/mock-only-`);
  const guard = watchConnects();
  let port;
  try {
    await withApp({ env: ON, dir }, async (app) => {
      port = app.port;
      const { call } = app;
      for (const fixture of ['sample', 'hostile']) {
        const c = await call('POST', '/api/connections', { transport: 'mock', fixture });
        assert.equal(c.status, 201);
        assert.equal(c.json.test.ok, true);
        const id = c.json.connection.id;
        assert.equal((await call('GET', `/api/connections/${id}/tools`)).status, 200);
        const scan = await call('POST', `/api/connections/${id}/scan`, {});
        assert.equal(scan.status, 200);
        if (fixture === 'hostile') assert.ok(scan.json.report.findings.length > 0, 'hostile fixture is flagged');
        else assert.equal(scan.json.report.findings.length, 0);
      }
      const list = await call('GET', '/api/connections');
      assert.deepEqual(list.json.connections.map((c) => c.id).sort(), ['mock-hostile', 'mock-sample']);
      assert.equal((await call('POST', '/api/scan', { snapshot: { tools: [{ name: 'a', description: 'b', inputSchema: { type: 'object' } }] } })).status, 200);
      assert.equal((await call('DELETE', '/api/connections/mock-sample')).status, 204);
      assert.deepEqual(fs.readdirSync(dir), [], 'nothing is written to the data dir');
    });
    assert.ok(guard.seen.length > 0, 'the guard saw the test client reaching the app');
    for (const s of guard.seen) assert.equal(s, `127.0.0.1:${port}`, `unexpected outbound connect to ${s}`);
  } finally { guard.stop(); }
});

test('MOCK_ONLY off: the same URL is accepted and the server is reached', T, async () => {
  const fake = await startFakeMcp();
  try {
    await withApp({}, async ({ call }) => {
      const r = await call('POST', '/api/connections', { transport: 'http', label: 'ok', url: fake.url });
      assert.equal(r.status, 201);
      assert.equal(r.json.test.ok, true);
      assert.ok(fake.seen.methods.includes('initialize'));
      const cfg = (await call('GET', '/api/config')).json;
      assert.equal(cfg.mockOnly, false);
      assert.equal((await call('GET', '/api/health')).json.mode, undefined);
    });
  } finally { await fake.close(); }
});

test('health reports mode: mock-only (true and 1 both switch it on)', T, async () => {
  for (const v of ['1', 'true']) {
    await withApp({ env: { MOCK_ONLY: v } }, async ({ call }) => {
      const r = await call('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.json.mode, 'mock-only');
      assert.equal(r.json.state, 'ready');
    });
  }
  await withApp({ env: { MOCK_ONLY: '0' } }, async ({ call }) => assert.equal((await call('POST', '/api/connections', { transport: 'http', url: 'http://127.0.0.1:1/' })).status, 201));
});
