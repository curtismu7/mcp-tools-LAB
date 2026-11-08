// GET /api/connections/:id/fill: demo values for our own servers and the signed-in identity (claims, never the token).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFill, identityFrom, loadSampleValues } from '../src/fill.js';
import { loadKnownServers } from '../src/knownServers.js';
import { startApp } from './helpers.js';

const T = { timeout: 20_000 };
const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('sample values are plain, match known servers, and carry no ids, secrets or URLs', () => {
  const samples = loadSampleValues();
  const known = new Set(loadKnownServers().map((s) => s.id));
  for (const [id, values] of samples) {
    assert.ok(known.has(id), `${id} is a server in known-servers.json`);
    for (const [k, v] of Object.entries(values)) {
      assert.match(k, /^[A-Za-z0-9_]+$/);
      assert.ok(!/(^|_)ids?$|Id$/.test(k), `${id}.${k}: ids are looked up, never shipped`);
      assert.ok(!/https?:|@|\/\/|token|secret|password/i.test(String(v)), `${id}.${k}`);
    }
  }
});

test('identityFrom reads claims only, ignores a non-JWT, and drops oversized values', () => {
  assert.deepEqual(identityFrom(jwt({ sub: 'u-1', email: 'a@corp.example', preferred_username: 'alice', name: 'Alice', secret: 'x' })), { sub: 'u-1', email: 'a@corp.example', username: 'alice', name: 'Alice' });
  assert.equal(identityFrom('opaque-token'), null);
  assert.equal(identityFrom(jwt({ nothing: 1 })), null);
  assert.equal(identityFrom(jwt({ sub: 'x'.repeat(300) })), null);
  assert.equal(identityFrom(undefined), null);
});

test('demoFor matches a connection to our server by URL; an unknown server gets nothing', () => {
  const fill = createFill();
  const weather = loadKnownServers().find((s) => s.id === 'weather');
  assert.equal(fill.demoFor({ url: weather.url }).city_name, 'Austin');
  assert.equal(fill.demoFor({ url: weather.url }).location_name, undefined, 'a saved-location name is not made up');
  assert.deepEqual(fill.demoFor({ url: 'http://127.0.0.1:1/mcp' }), {});
  assert.deepEqual(fill.demoFor({ transport: 'stdio' }), {});
});

test('the fill endpoint: demo values for our server, no identity when signed out, nothing on a mock-only copy', T, async () => {
  const weather = loadKnownServers().find((s) => s.id === 'weather');
  const app = await startApp();
  try {
    const id = (await app.call('POST', '/api/connections', { transport: 'http', url: weather.url, label: 'weather' })).json.connection.id;
    const r = await app.call('GET', `/api/connections/${id}/fill`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.json.demo.city_name, 'Austin');
    assert.equal(r.json.identity, null);
    const other = (await app.call('POST', '/api/connections', { transport: 'http', url: 'http://127.0.0.1:1/mcp' })).json.connection.id;
    assert.deepEqual((await app.call('GET', `/api/connections/${other}/fill`)).json, { demo: {}, identity: null });
    assert.equal((await app.call('GET', '/api/connections/nope/fill')).status, 404);
    assert.equal((await app.call('GET', '/api/connections/__proto__/fill')).status, 404);
  } finally { await app.close(); }
  const mock = await startApp({ env: { MOCK_ONLY: '1' } });
  try { assert.deepEqual((await mock.call('GET', '/api/connections/mock-sample/fill')).json, { demo: {}, identity: null }); } finally { await mock.close(); }
});
