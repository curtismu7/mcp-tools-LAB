import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { listKnownServers, loadKnownServers, probe, validateKnownServers } from '../src/knownServers.js';
import { startApp } from './helpers.js';

const T = { timeout: 20_000 };
const entry = (o = {}) => ({ id: 'a', label: 'A', transport: 'http', url: 'http://127.0.0.1:4730/mcp', ...o });
const doc = (...servers) => ({ schema: 'known-servers/1', servers });

test('the committed list is valid: loopback http servers with a port, unique ids, no credentials', T, () => {
  const list = loadKnownServers();
  assert.ok(list.length >= 2);
  assert.deepEqual([...new Set(list.map((s) => s.id))].sort(), list.map((s) => s.id).sort(), 'ids are unique');
  for (const s of list) {
    const u = new URL(s.url);
    assert.equal(u.protocol, 'http:');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname), `${s.id} is loopback`);
    assert.ok(u.port, `${s.id} has a port`);
    assert.equal(u.username + u.password, '');
  }
  assert.ok(list.some((s) => s.id === 'everything') && list.some((s) => s.id === 'hostile-mcp'));
});

test('validation refuses anything that is not a plain loopback http entry', T, () => {
  assert.throws(() => validateKnownServers(null), /expected/);
  assert.throws(() => validateKnownServers(doc(entry({ url: 'http://10.0.0.5:4730/mcp' }))), /loopback/);
  assert.throws(() => validateKnownServers(doc(entry({ url: 'http://example.com:4730/mcp' }))), /loopback/);
  assert.throws(() => validateKnownServers(doc(entry({ url: 'https://127.0.0.1:4730/mcp' }))), /loopback/);
  assert.throws(() => validateKnownServers(doc(entry({ url: 'http://127.0.0.1/mcp' }))), /port/);
  assert.throws(() => validateKnownServers(doc(entry({ url: 'http://u:p@127.0.0.1:4730/mcp' }))), /credentials/);
  assert.throws(() => validateKnownServers(doc(entry({ token: 'Bearer x' }))), /secrets never belong/);
  assert.throws(() => validateKnownServers(doc(entry({ transport: 'stdio' }))), /only http/);
  assert.throws(() => validateKnownServers(doc(entry(), entry())), /duplicate/);
  assert.throws(() => validateKnownServers(doc(entry({ id: '../x' }))), /bad or duplicate id/);
});

test('probe: true for a listening loopback port, false once it is closed, false on a timeout-free refusal', T, async () => {
  const srv = net.createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const url = `http://127.0.0.1:${port}/mcp`;
  assert.equal(await probe(url), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await probe(url), false);
});

test('listKnownServers adds running from the probe and survives a probe that throws', T, async () => {
  const servers = validateKnownServers(doc(entry({ id: 'up' }), entry({ id: 'down', url: 'http://127.0.0.1:4731/mcp' }), entry({ id: 'boom', url: 'http://127.0.0.1:4732/mcp' })));
  const out = await listKnownServers({ servers, probe: async (u) => { if (u.includes(':4732')) throw new Error('x'); return u.includes(':4730'); } });
  assert.deepEqual(out.map((s) => [s.id, s.running]), [['up', true], ['down', false], ['boom', false]]);
});

test('GET /api/known-servers lists our servers with a running flag, uncached; the hosted mock lists none', T, async () => {
  const app = await startApp({});
  try {
    const r = await app.call('GET', '/api/known-servers');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    const body = r.json;
    assert.ok(body.servers.length >= 2);
    for (const s of body.servers) { assert.equal(typeof s.running, 'boolean'); assert.ok(s.url.startsWith('http://127.0.0.1:')); assert.equal(s.token, undefined); }
  } finally { await app.close(); }
  const mock = await startApp({ env: { MOCK_ONLY: '1' } });
  try {
    const r = await mock.call('GET', '/api/known-servers');
    assert.deepEqual(r.json, { servers: [] });
  } finally { await mock.close(); }
});

test('the Docker image ships the list (the production stage copies only what it names)', T, () => {
  const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^COPY server\/data server\/data$/m);
});
