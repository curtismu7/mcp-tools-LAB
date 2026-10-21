import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedHostNames, assertBindAllowed, bindHost, hostCheck, isLoopbackHost, sameOriginWrites } from '../src/security.js';

const run = (mw, req) => new Promise((resolve) => {
  const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  mw(req, res, () => resolve({ code: 200 }));
});

test('loopback names are recognised, others are not', () => {
  for (const h of ['localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]', 'LOCALHOST']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['example.com', '10.0.0.1', '0.0.0.0', '127.0.0.1.evil.test', '']) assert.ok(!isLoopbackHost(h), h);
});

test('bind: loopback by default, anything else needs MCPTOOLS_BIND', () => {
  assert.equal(bindHost({}), '127.0.0.1');
  assert.equal(assertBindAllowed('127.0.0.1', {}), '127.0.0.1');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /MCPTOOLS_BIND/);
  assert.equal(assertBindAllowed('0.0.0.0', { MCPTOOLS_BIND: '0.0.0.0' }), '0.0.0.0');
});

test('Host check: loopback passes, a rebinding name is refused, an operator-listed name passes', async () => {
  const mw = hostCheck({});
  assert.equal((await run(mw, { headers: { host: '127.0.0.1:4810' } })).code, 200);
  assert.equal((await run(mw, { headers: { host: 'localhost:4810' } })).code, 200);
  assert.equal((await run(mw, { headers: { host: '[::1]:4810' } })).code, 200);
  assert.equal((await run(mw, { headers: { host: 'evil.example:4810' } })).code, 403);
  assert.equal((await run(mw, { headers: {} })).code, 403);
  const listed = hostCheck({ MCPTOOLS_BIND: '0.0.0.0', MCPTOOLS_ALLOWED_HOSTS: 'tools.lan' });
  assert.equal((await run(listed, { headers: { host: 'tools.lan:80' } })).code, 200);
  assert.deepEqual(allowedHostNames({ MCPTOOLS_BIND: '192.168.1.5' }), ['192.168.1.5']);
});

test('same-origin writes: GET is free; a write needs an Origin equal to Host', async () => {
  const mw = sameOriginWrites();
  assert.equal((await run(mw, { method: 'GET', headers: {} })).code, 200);
  assert.equal((await run(mw, { method: 'POST', headers: { host: 'localhost:1', origin: 'http://localhost:1' } })).code, 200);
  assert.equal((await run(mw, { method: 'POST', headers: { host: 'localhost:1' } })).code, 403);
  assert.equal((await run(mw, { method: 'POST', headers: { host: 'localhost:1', origin: 'http://evil.example' } })).code, 403);
  assert.equal((await run(mw, { method: 'DELETE', headers: { host: 'localhost:1', origin: 'http://localhost:2' } })).code, 403);
  assert.equal((await run(mw, { method: 'POST', headers: { host: 'localhost:1', origin: 'null' } })).code, 403);
});
