// Hosting the mock: a non-loopback bind and an allowed Host name are explicit opt-ins, and defaults stay loopback.
// The served case runs the real entry point (src/index.js) so bind, doctor and the Host guard are exercised together.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../src/index.js';
import { createApp } from '../src/app.js';
import { runChecks } from '../src/doctor.js';
import { createMockStore } from '../src/mock.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const T = { timeout: 60_000 };
const HOSTED = 'mock.mcp-tools.example';

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// fetch() cannot set Host, so use http.request to send the Host header a proxy or ingress would.
const get = (port, p, host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject); req.end();
});

async function startEntry(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let exited = false;
  for (const s of [child.stdout, child.stderr]) s.on('data', (c) => { output += c; });
  child.once('exit', () => { exited = true; });
  const end = Date.now() + 30_000;
  while (!exited && Date.now() < end) {
    try { if ((await get(port, '/api/health', `127.0.0.1:${port}`)).status === 200) return { port, child }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start (exited=${exited}): ${output.trim()}`);
}

test('hosted mock: MOCK_ONLY + MCPTOOLS_BIND + MCPTOOLS_ALLOWED_HOSTS serves the allowed Host and rejects others', T, async () => {
  const { port, child } = await startEntry({ MOCK_ONLY: '1', MCPTOOLS_BIND: '0.0.0.0', MCPTOOLS_ALLOWED_HOSTS: HOSTED });
  try {
    for (const host of [HOSTED, `${HOSTED}:8443`, HOSTED.toUpperCase()]) {
      const res = await get(port, '/api/health', host);
      assert.equal(res.status, 200, host);
      assert.equal(JSON.parse(res.body).mode, 'mock-only');
    }
    for (const host of ['evil.mcp-tools.example', `${HOSTED}.evil.invalid`, '10.1.2.3:4810']) {
      const res = await get(port, '/api/health', host);
      assert.equal(res.status, 403, `Host "${host}"`);
      assert.equal(JSON.parse(res.body).error, 'bad_host');
    }
    // Loopback names stay allowed (local checks, port-forward).
    assert.equal((await get(port, '/api/health', `localhost:${port}`)).status, 200);
  } finally { child.kill(); }
});

test('without the hosting settings a non-loopback bind is still refused, MOCK_ONLY or not', T, async () => {
  const saved = process.env.MCPTOOLS_BIND;
  delete process.env.MCPTOOLS_BIND;
  try {
    for (const env of [{}, { MOCK_ONLY: '1' }]) {
      assert.throws(() => startHttpServer({ port: 0, host: '0.0.0.0', app: createApp({ env, store: createMockStore() }) }), /refusing to bind 0\.0\.0\.0/);
    }
    const bind = runChecks({ env: { MOCK_ONLY: '1' } }).find((c) => c.id === 'bind');
    assert.match(bind.detail, /^127\.0\.0\.1 \(loopback\)/);
  } finally { if (saved !== undefined) process.env.MCPTOOLS_BIND = saved; }
});

test('without MCPTOOLS_ALLOWED_HOSTS the hosted name is refused even when bound wide', T, async () => {
  const { port, child } = await startEntry({ MOCK_ONLY: '1', MCPTOOLS_BIND: '0.0.0.0' });
  try {
    assert.equal((await get(port, '/api/health', HOSTED)).status, 403);
    assert.equal((await get(port, '/api/health', `127.0.0.1:${port}`)).status, 200);
  } finally { child.kill(); }
});
