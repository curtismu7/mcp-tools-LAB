// Behind the family lab-proxy: Host is this tool's LAB_ALLOWED_HOSTS name with its PORT, the browser's Origin is the
// launcher's, and the proxy says so in X-Forwarded-Host/-Proto. Placeholder names here; compose sets the real one.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { startHttpServer } from '../src/index.js';
import { labProxyHosts } from '../src/security.js';
import { createStore } from '../src/store.js';
import { TEST_PORTS, tmpDir } from './helpers.js';

const NAME = 'mcp-tools.proxy.example';
const XFH = 'launcher.example:8443';
const PROXY = `https://${XFH}`;
const fwd = { 'x-forwarded-host': XFH, 'x-forwarded-proto': 'https' };

async function withTool(fn) {
  for (const port of TEST_PORTS) {
    const dir = tmpDir();
    const env = { DATA_DIR: dir, PORT: String(port), LAB_ALLOWED_HOSTS: ` ${NAME.toUpperCase()} ` };
    let srv;
    try { srv = await startHttpServer({ port, host: '127.0.0.1', app: createApp({ env, store: createStore({ dir }) }) }); } catch (err) { if (err?.code === 'EADDRINUSE') continue; throw err; }
    try { return await fn(port); } finally { await srv.close(); }
  }
  throw new Error('no free test port');
}
const send = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
  });
  req.on('error', reject); req.end(body);
});
const write = (port, headers) => send(port, 'POST', '/api/mode', headers, JSON.stringify({ source: 'mock' }));

test('LAB_ALLOWED_HOSTS: unset is none; names become <name>:<PORT>; a port or URL is refused', () => {
  assert.deepEqual([...labProxyHosts({})], []);
  assert.deepEqual([...labProxyHosts({ LAB_ALLOWED_HOSTS: 'A.example, b.example,', PORT: '4810' })], ['a.example:4810', 'b.example:4810']);
  for (const bad of ['a.example:4810', 'http://a.example', 'a.example/x']) assert.throws(() => labProxyHosts({ LAB_ALLOWED_HOSTS: bad }));
});

test('launcher Host <name>:<PORT> is accepted; the bare name, another port or a Host outside the set is refused', async () => {
  await withTool(async (port) => {
    assert.equal((await send(port, 'GET', '/api/health', { host: `${NAME}:${port}` })).status, 200);
    for (const host of [NAME, `${NAME}:1`, `proxy.example:${port}`, XFH, `evil.example:${port}`]) {
      assert.equal((await send(port, 'GET', '/api/health', { host })).status, 403, host);
    }
  });
});

test('a proxied same-origin write is accepted; a foreign or mismatched Origin is refused', async () => {
  await withTool(async (port) => {
    const host = `${NAME}:${port}`;
    const ok = await write(port, { host, ...fwd, origin: PROXY });
    assert.notEqual(ok.status, 403, ok.text);
    assert.equal(ok.status, 200, ok.text);
    for (const origin of ['https://evil.example', `http://${XFH}`, `https://${XFH.split(':')[0]}`]) {
      assert.equal((await write(port, { host, ...fwd, origin })).status, 403, origin);
    }
    assert.equal((await write(port, { host, ...fwd, 'x-forwarded-proto': 'ftp', origin: `ftp://${XFH}` })).status, 403);
    assert.equal((await write(port, { host, 'x-forwarded-proto': 'https', origin: 'https://' })).status, 403);
    assert.equal((await write(port, { host, 'x-forwarded-host': XFH, origin: PROXY })).status, 403, 'no X-Forwarded-Proto');
  });
});

test('forwarded headers on a loopback Host are ignored; a Host outside the set is refused before any Origin check', async () => {
  await withTool(async (port) => {
    assert.equal((await write(port, { host: `127.0.0.1:${port}`, ...fwd, origin: PROXY })).status, 403);
    assert.equal((await write(port, { host: `localhost:${port}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' })).status, 403);
    const res = await write(port, { host: `evil.example:${port}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match(res.text, /bad_host/);
  });
});
