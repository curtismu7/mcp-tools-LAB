// Flags: /api/connections/:id/flags and server/src/flags.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { startFakeMcp as startFake } from './fixtures/fakeMcp.js';
import { startApp } from './helpers.js';
import { createFlagStore, FLAG_LIMITS } from '../src/flags.js';

const T = { timeout: 20_000 };
const opened = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((s) => s.close())); });
async function withConn(fn, opts = {}) {
  const fake = await startFake({}); opened.push(fake);
  const app = await startApp(opts);
  try {
    const c = await app.call('POST', '/api/connections', { transport: 'http', url: fake.url, label: 'fake' });
    await fn(app, c.json.connection.id);
  } finally { await app.close(); }
}

test('flag, replace the note, list, unflag; mode 600; same-origin writes; bad input 400; unknown connection 404', T, async () => {
  await withConn(async ({ call, dir }, id) => {
    const p = `/api/connections/${id}/flags`;
    const a = await call('PUT', p, { kind: 'tool', name: 'get_time', note: 'asks for a transfer' });
    assert.equal(a.status, 200);
    const b = await call('PUT', p, { kind: 'tool', name: 'get_time', note: 'renamed note' });
    assert.equal(b.json.flag.id, a.json.flag.id, 'same item: one flag, note replaced');
    await call('PUT', p, { kind: 'resource', name: 'mcp://r', note: '' });
    const list = (await call('GET', p)).json.flags;
    assert.deepEqual(list.map((f) => [f.kind, f.name, f.note]).sort(), [['resource', 'mcp://r', ''], ['tool', 'get_time', 'renamed note']]);
    assert.equal(fs.statSync(path.join(dir, 'flags.json')).mode & 0o777, 0o600);
    assert.equal((await call('PUT', p, { kind: 'server', name: 'x' })).status, 400);
    assert.equal((await call('PUT', p, { kind: 'tool', name: '' })).status, 400);
    assert.equal((await call('PUT', p, { kind: 'tool', name: 'x', note: 'n'.repeat(FLAG_LIMITS.noteChars + 1) })).status, 400);
    assert.equal((await call('PUT', p, { kind: 'tool', name: 'x', other: 1 })).status, 400);
    assert.equal((await call('PUT', p, { kind: 'tool', name: 'x' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('PUT', '/api/connections/nope/flags', { kind: 'tool', name: 'x' })).status, 404);
    assert.equal((await call('DELETE', `${p}/${a.json.flag.id}`)).status, 204);
    assert.equal((await call('DELETE', `${p}/${a.json.flag.id}`)).status, 404);
    assert.equal((await call('GET', p)).json.flags.length, 1);
  });
});

test('flags go with their connection and on Reset', T, async () => {
  await withConn(async ({ call, dir }, id) => {
    await call('PUT', `/api/connections/${id}/flags`, { kind: 'tool', name: 't' });
    await call('DELETE', `/api/connections/${id}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'flags.json'), 'utf8')), []);
  });
  await withConn(async ({ call, dir }, id) => {
    await call('PUT', `/api/connections/${id}/flags`, { kind: 'tool', name: 't' });
    await call('POST', '/api/reset');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'flags.json'), 'utf8')), []);
  });
});

test('the per-connection cap counts new items only; a MOCK_ONLY copy refuses flags', T, async () => {
  const s = createFlagStore();
  for (let i = 0; i < FLAG_LIMITS.perConnection; i += 1) s.put('c', { kind: 'tool', name: `t${i}` });
  assert.throws(() => s.put('c', { kind: 'tool', name: 'new' }), /at most/);
  assert.doesNotThrow(() => s.put('c', { kind: 'tool', name: 't0', note: 'edit is fine at the cap' }));
  const app = await startApp({ env: { MOCK_ONLY: '1' } });
  try { assert.equal((await app.call('PUT', '/api/connections/mock-sample/flags', { kind: 'tool', name: 'add' })).status, 403); } finally { await app.close(); }
});
