// Regression tests for the live proxy review (2026-11-07): prototype ids, JSON errors, streams closed on off, the
// client-facing scrub (split chunks, JSON-escaped secrets), redirects, bridge error scrubbing, header timeout.
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { afterEach } from 'node:test';
import express from 'express';
import { startApp } from './helpers.js';
import { createProxy } from '../src/proxy/router.js';
import { createStreamScrubber, captureBody, MAX_BODY } from '../src/proxy/flows.js';

const T = { timeout: 20_000 };
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))); });
function upstream(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}/mcp`)));
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const post = (origin, path, token, body, extra = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function realProxy(app, url, token) {
  const c = await app.call('POST', '/api/connections', { transport: 'http', url, ...(token ? { token } : {}) });
  await app.call('POST', '/api/mode', { source: 'real' });
  const v = (await app.call('POST', '/api/proxy', { enabled: true })).json;
  return { id: c.json.connection.id, token: v.token };
}

test('an id like __proto__, constructor or toString is a 404 and the server stays up (Real and Mock)', T, async () => {
  const app = await startApp();
  try {
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    for (const mode of ['mock', 'real']) {
      await app.call('POST', '/api/mode', { source: mode });
      for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const r = await post(app.origin, `/proxy/mcp/${id}`, token, INIT);
        assert.equal(r.status, 404, `${mode} ${id}`);
      }
    }
    assert.equal((await app.call('GET', '/api/health')).status, 200);
  } finally { await app.close(); }
});

test('proxy errors are JSON, never an HTML page with a stack', T, async () => {
  const app = await startApp();
  try {
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const big = await post(app.origin, '/proxy/mcp/mock-sample', token, 'x'.repeat(5 * 1024 * 1024));
    assert.equal(big.status, 413);
    assert.match(big.headers.get('content-type'), /application\/json/);
    assert.ok(!(await big.text()).includes('<pre>'));
    const other = await post(app.origin, '/proxy/elsewhere', token, INIT);
    assert.equal(other.status, 404);
    assert.match(other.headers.get('content-type'), /application\/json/);
  } finally { await app.close(); }
});

test('turning the proxy off closes a stream that is still open', T, async () => {
  const url = await upstream((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message\ndata: {"n":1}\n\n'); return; } // held open
    res.writeHead(202).end();
  });
  const app = await startApp();
  try {
    const { id, token } = await realProxy(app, url);
    const r = await fetch(`${app.origin}/proxy/mcp/${id}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"n":1/);
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.at(-1).open, true);
    await app.call('POST', '/api/proxy', { enabled: false });
    const end = await Promise.race([reader.read().then((x) => x.done).catch(() => true), new Promise((res) => setTimeout(() => res('still open'), 3000))]);
    assert.equal(end, true, 'the stream ended after the proxy was turned off');
  } finally { await app.close(); }
});

test('the client never gets the saved credential back: split across chunks, or JSON-escaped', T, async () => {
  const SECRET = 'Bearer split"secret\\value-987';
  const escaped = JSON.stringify(SECRET).slice(1, -1);
  const url = await upstream((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echo: req.headers.authorization } }); // the escaped form is in here
      const cut = text.indexOf(escaped) + 7;
      res.write(text.slice(0, cut));
      setTimeout(() => res.end(text.slice(cut)), 50); // the secret straddles two chunks
    });
  });
  const app = await startApp();
  try {
    const { id, token } = await realProxy(app, url, SECRET);
    const text = await (await post(app.origin, `/proxy/mcp/${id}`, token, INIT)).text();
    assert.ok(!text.includes(escaped) && !text.includes(escaped.slice(0, 12)), `client text: ${text.slice(0, 80)}`);
    assert.equal(JSON.parse(text).result.echo, '[redacted]');
    const f = (await app.call('GET', '/api/proxy/flows')).json.flows.at(-1);
    assert.ok(!(await app.call('GET', `/api/proxy/flows/${f.id}`)).text.includes('split'));
  } finally { await app.close(); }
});

test('the stream scrubber holds back only a possible secret start, and captureBody scrubs before it cuts', () => {
  const s = createStreamScrubber(['abcdef']);
  assert.equal(s.push('data: x\n\n'), 'data: x\n\n', 'nothing held when no secret can start here');
  assert.equal(s.push('zz ab'), 'zz ');
  assert.equal(s.push('cdef!'), '[redacted]!');
  assert.equal(s.push('ab'), '');
  assert.equal(s.end(), 'ab');
  const secret = 'SAVEDSECRET-xyz';
  const cut = captureBody('a'.repeat(MAX_BODY - 5) + secret, { secrets: [secret] });
  assert.ok(!cut.text.includes('SAVED'));
  assert.equal(captureBody('{"t":"tok\\"en1234"}', { secrets: ['tok"en1234'] }).json.t, '[redacted]');
});

test('an upstream redirect is refused (502) and not followed', T, async () => {
  let followed = 0;
  const target = await upstream((_req, res) => { followed += 1; res.writeHead(200).end('{}'); });
  const url = await upstream((_req, res) => res.writeHead(302, { location: target }).end());
  const app = await startApp();
  try {
    const { id, token } = await realProxy(app, url, 'Bearer must-not-travel');
    const r = await post(app.origin, `/proxy/mcp/${id}`, token, INIT);
    assert.equal(r.status, 502);
    assert.match((await r.json()).message, /redirects are not followed/);
    assert.equal(followed, 0);
  } finally { await app.close(); }
});

test('a bridged error that echoes the proxy token is scrubbed for the client and the log', T, async () => {
  const app = await startApp();
  try {
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const r = await post(app.origin, '/proxy/mcp/mock-sample', token, { jsonrpc: '2.0', id: 9, method: `x-${token}` });
    const text = await r.text();
    assert.ok(!text.includes(token));
    assert.match(JSON.parse(text).error.message, /\[redacted\]/);
    // a result (not an error) that echoes it: the fixture's tools/call repeats the tool name
    const ok = await (await post(app.origin, '/proxy/mcp/mock-sample', token, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: token, arguments: {} } })).text();
    assert.ok(!ok.includes(token));
    assert.match(ok, /mock result for \[redacted\]/);
  } finally { await app.close(); }
});

test('a bridged route forwards the request as sent, not the capped, scrubbed log copy', T, async () => {
  const app = await startApp();
  try {
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const big = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add', arguments: { pad: 'x'.repeat(MAX_BODY + 100) } } };
    const r = await (await post(app.origin, '/proxy/mcp/mock-sample', token, big)).json();
    assert.match(r.result.content[0].text, /mock result for add/, 'a body over the log cap still reaches the server whole');
  } finally { await app.close(); }
});

test('an upstream that never sends headers ends in a 502 after the header timeout', T, async () => {
  const url = await upstream(() => { /* never answers */ });
  const conn = { id: 'c1', label: 'slow', transport: 'http', url };
  const p = createProxy({ store: { get: (id) => (id === 'c1' ? conn : null), list: () => [conn] }, manager: null, getMode: () => 'real', mockOnly: false, secretsFor: () => [], headerTimeoutMs: 200 });
  const app = express();
  app.use('/api/proxy', express.Router().use(p.api));
  app.use('/proxy', p.proxy);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const { token } = await (await fetch(`${origin}/api/proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).json();
  const started = Date.now();
  const r = await post(origin, '/proxy/mcp/c1', token, INIT);
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /no response headers/);
  assert.ok(Date.now() - started < 5000);
});

test('a Mock/Real switch empties the flow log and closes open streams; the proxy stays on', T, async () => {
  const url = await upstream((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message\ndata: {"n":1}\n\n'); return; }
    res.writeHead(202).end();
  });
  const app = await startApp();
  try {
    const { id, token } = await realProxy(app, url);
    const r = await fetch(`${app.origin}/proxy/mcp/${id}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    const reader = r.body.getReader();
    await reader.read();
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.length, 1);
    await app.call('POST', '/api/mode', { source: 'mock' });
    const end = await Promise.race([reader.read().then((x) => x.done).catch(() => true), new Promise((res) => setTimeout(() => res('still open'), 3000))]);
    assert.equal(end, true);
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.length, 0);
    const v = (await app.call('GET', '/api/proxy')).json;
    assert.equal(v.enabled, true);
    assert.equal(v.token, token);
    await app.call('POST', '/api/mode', { source: 'mock' }); // same mode again: nothing is cleared
    await post(app.origin, '/proxy/mcp/mock-sample', token, INIT);
    await app.call('POST', '/api/mode', { source: 'mock' });
    assert.equal((await app.call('GET', '/api/proxy/flows')).json.flows.length, 1);
  } finally { await app.close(); }
});
