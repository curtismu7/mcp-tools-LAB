// The live proxy's stdio stream: server-initiated messages reach the client over SSE, and the client's answers and
// notifications reach the server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.js';

const T = { timeout: 30_000 };
const STDIO = fileURLToPath(new URL('./fixtures/stdioServer.mjs', import.meta.url));
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 't', version: '1' } } };

// Reads SSE events from a fetch body until `want` of them arrived.
function events(body) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = ''; const got = [];
  return {
    got,
    async until(want, ms = 5000) {
      const stop = Date.now() + ms;
      while (got.length < want && Date.now() < stop) {
        const { done, value } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), 200))]);
        if (done) break;
        if (value) { buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) !== -1) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const d = ev.split('\n').find((l) => l.startsWith('data: ')); if (d) got.push(JSON.parse(d.slice(6))); } }
      }
      return got;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

test('stdio: GET opens a stream with the server\'s own messages; the client answers a server request by POST', T, async () => {
  const app = await startApp();
  try {
    const c = await app.call('POST', '/api/connections', { transport: 'stdio', command: process.execPath, args: [STDIO], label: 'stdio fake' });
    assert.equal(c.status, 201);
    const id = c.json.connection.id;
    await app.call('POST', '/api/mode', { source: 'real' });
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const h = { Connection: 'close', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const url = `${app.origin}/proxy/mcp/${id}`;
    const send = (body) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.equal((await send(INIT)).status, 200);
    const sse = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const ev = events(sse.body);
    const call = send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: {} } }); // finishes after our answer
    const [progress, ask] = await ev.until(2);
    assert.equal(progress.method, 'notifications/progress');
    assert.equal(ask.method, 'roots/list');
    assert.equal(ask.id, 's-1');
    assert.equal((await send({ jsonrpc: '2.0', id: 's-1', result: { roots: [{ uri: 'file:///a' }, { uri: 'file:///b' }] } })).status, 202);
    const done = await (await call).json();
    assert.equal(done.result.content[0].text, 'asked');
    const [, , log] = await ev.until(3);
    assert.deepEqual(log.params, { level: 'info', data: 'roots: 2' });
    // a client notification is forwarded (initialized is not: the tool already sent its own)
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' })).status, 202);
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const seen = await (await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'seen', arguments: {} } })).json();
    assert.equal(seen.result.content[0].text, 'notifications/initialized,notifications/roots/list_changed');
    // the stream's messages are logged, one flow each
    const flows = (await app.call('GET', '/api/proxy/flows')).json.flows.filter((f) => f.via === 'stream').map((f) => f.rpcMethod);
    assert.deepEqual(flows, ['notifications/progress', 'roots/list', 'notifications/message']);
    // turning the proxy off ends the stream
    await app.call('POST', '/api/proxy', { enabled: false });
    const before = ev.got.length;
    await ev.until(before + 1, 1500);
    assert.equal(ev.got.length, before);
    ev.cancel();
  } finally { await app.close(); }
});

test('fixtures (no stream) still answer GET with 405', T, async () => {
  const app = await startApp();
  try {
    const { token } = (await app.call('POST', '/api/proxy', { enabled: true })).json;
    const r = await fetch(`${app.origin}/proxy/mcp/mock-sample`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 405);
  } finally { await app.close(); }
});
