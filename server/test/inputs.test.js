// Saved inputs: /api/connections/:id/inputs and server/src/inputs.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { startFakeMcp as startFake } from './fixtures/fakeMcp.js';
import { startApp } from './helpers.js';
import { createInputStore, INPUT_LIMITS } from '../src/inputs.js';

const T = { timeout: 20_000 };
const opened = [];
async function startFakeMcp(o) { const s = await startFake(o); opened.push(s); return s; }
afterEach(async () => { await Promise.all(opened.splice(0).map((s) => s.close())); });
async function withConn(fn, opts = {}) {
  const fake = await startFakeMcp({});
  const app = await startApp(opts);
  try {
    const c = await app.call('POST', '/api/connections', { transport: 'http', url: fake.url, label: 'fake' });
    await fn(app, c.json.connection.id, fake);
  } finally { await app.close(); }
}

test('save, list (all and per tool), delete; the file is mode 600; saving calls nothing', T, async () => {
  await withConn(async ({ call, dir }, id, fake) => {
    const a = await call('POST', `/api/connections/${id}/inputs`, { tool: 'get_time', name: 'UTC', arguments: { tz: 'UTC' } });
    assert.equal(a.status, 201);
    assert.equal(a.json.input.source, 'manual');
    await call('POST', `/api/connections/${id}/inputs`, { tool: 'other', name: 'x', arguments: {}, source: 'flow' });
    assert.equal((await call('GET', `/api/connections/${id}/inputs`)).json.inputs.length, 2);
    const one = (await call('GET', `/api/connections/${id}/inputs?tool=get_time`)).json.inputs;
    assert.deepEqual(one.map((x) => [x.name, x.arguments]), [['UTC', { tz: 'UTC' }]]);
    assert.equal(fs.statSync(path.join(dir, 'inputs.json')).mode & 0o777, 0o600);
    assert.equal(fake.seen.calls.length, 0, 'saving an input never calls the tool');
    assert.equal((await call('DELETE', `/api/connections/${id}/inputs/${a.json.input.id}`)).status, 204);
    assert.equal((await call('DELETE', `/api/connections/${id}/inputs/${a.json.input.id}`)).status, 404);
    assert.equal((await call('GET', `/api/connections/${id}/inputs`)).json.inputs.length, 1);
  });
});

test('bad input is refused with 400 and nothing is stored; an unknown connection is 404; writes are same-origin', T, async () => {
  await withConn(async ({ call }, id) => {
    const p = `/api/connections/${id}/inputs`;
    assert.equal((await call('POST', p, { tool: 'get_time', arguments: {} })).status, 400, 'no name');
    assert.equal((await call('POST', p, { tool: 'get_time', name: 'n', arguments: [1] })).status, 400, 'array args');
    assert.equal((await call('POST', p, { tool: '', name: 'n', arguments: {} })).status, 400, 'no tool');
    assert.equal((await call('POST', p, { tool: 't', name: 'x'.repeat(INPUT_LIMITS.nameChars + 1), arguments: {} })).status, 400);
    assert.equal((await call('POST', p, { tool: 't', name: 'n', arguments: { big: 'x'.repeat(INPUT_LIMITS.argBytes) } })).status, 400);
    assert.equal((await call('POST', p, { tool: 't', name: 'n', arguments: {}, extra: 1 })).status, 400);
    assert.equal((await call('POST', p, { tool: 't', name: 'n', arguments: {} }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('GET', p)).json.inputs.length, 0);
    assert.equal((await call('GET', '/api/connections/nope/inputs')).status, 404);
    assert.equal((await call('POST', '/api/connections/nope/inputs', { tool: 't', name: 'n', arguments: {} })).status, 404);
  });
});

test('deleting the connection removes its inputs; Reset removes all', T, async () => {
  await withConn(async ({ call, dir }, id) => {
    await call('POST', `/api/connections/${id}/inputs`, { tool: 't', name: 'n', arguments: {} });
    await call('DELETE', `/api/connections/${id}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8')), []);
  });
  await withConn(async ({ call, dir }, id) => {
    await call('POST', `/api/connections/${id}/inputs`, { tool: 't', name: 'n', arguments: {} });
    await call('POST', '/api/reset');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8')), []);
  });
});

test('at most INPUT_LIMITS.perConnection per connection; entries of a vanished connection are dropped', () => {
  let alive = true;
  const s = createInputStore({ connectionExists: (id) => id === 'c1' || (id === 'c2' && alive) });
  for (let i = 0; i < INPUT_LIMITS.perConnection; i += 1) s.create('c1', { tool: 't', name: `n${i}`, arguments: {} });
  assert.throws(() => s.create('c1', { tool: 't', name: 'one more', arguments: {} }), /at most/);
  s.create('c2', { tool: 't', name: 'n', arguments: {} });
  alive = false;
  s.remove('c1', s.list('c1')[0].id);
  assert.equal(s.list('c2').length, 0);
  assert.equal(s.file, null, 'a memory store has no file');
});

test('a MOCK_ONLY copy refuses to save inputs (nothing shared between visitors)', T, async () => {
  const app = await startApp({ env: { MOCK_ONLY: '1' } });
  try {
    const r = await app.call('POST', '/api/connections/mock-sample/inputs', { tool: 'add', name: 'n', arguments: {} });
    assert.equal(r.status, 403);
    assert.deepEqual((await app.call('GET', '/api/connections/mock-sample/inputs')).json.inputs, []);
  } finally { await app.close(); }
});

test('delete is scoped to its own connection and same-origin; odd ids and queries are refused', T, async () => {
  const other = await startFakeMcp({});
  await withConn(async ({ call }, id) => {
    const b = (await call('POST', '/api/connections', { transport: 'http', url: other.url, label: 'b' })).json.connection.id;
    const inp = (await call('POST', `/api/connections/${id}/inputs`, { tool: 't', name: 'n', arguments: {} })).json.input;
    const fl = (await call('PUT', `/api/connections/${id}/flags`, { kind: 'tool', name: 't' })).json.flag;
    assert.equal((await call('DELETE', `/api/connections/${b}/inputs/${inp.id}`)).status, 404, 'another connection cannot delete it');
    assert.equal((await call('DELETE', `/api/connections/${b}/flags/${fl.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/connections/${id}/inputs/${inp.id}`, undefined, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('DELETE', `/api/connections/${id}/flags/${fl.id}`, undefined, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('GET', `/api/connections/${id}/inputs`)).json.inputs.length, 1);
    assert.equal((await call('GET', `/api/connections/${id}/flags`)).json.flags.length, 1);
    for (const odd of ['__proto__', 'constructor', 'toString']) {
      assert.equal((await call('POST', `/api/connections/${odd}/inputs`, { tool: 't', name: 'n', arguments: {} })).status, 404, odd);
      assert.equal((await call('PUT', `/api/connections/${odd}/flags`, { kind: 'tool', name: 't' })).status, 404, odd);
    }
    assert.equal((await call('GET', `/api/connections/${id}/inputs?tool[]=x`)).status, 400);
  });
});
