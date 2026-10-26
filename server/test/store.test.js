import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createStore } from '../src/store.js';
import { tmpDir } from './helpers.js';

test('http connections persist with mode 600 in a mode 700 directory; the token is never in the public view', () => {
  const dir = path.join(tmpDir(), 'state');
  const store = createStore({ dir });
  const rec = store.create({ transport: 'http', label: 'a', url: 'https://svc.example/mcp?key=qwerty123', authHeader: 'Authorization', token: 'Bearer s3cr3t-token' });
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const view = store.publicView(rec);
  assert.equal(view.token, 'set');
  assert.ok(!JSON.stringify(view).includes('s3cr3t'));
  assert.ok(!JSON.stringify(view).includes('qwerty123'), 'query values are masked');
  assert.equal(view.urlHasQuery, true);
  assert.ok(store.secretsOf(rec).includes('qwerty123'));
  assert.equal(store.get(rec.id).token, 'Bearer s3cr3t-token');
  assert.ok(store.remove(rec.id));
  assert.equal(store.get(rec.id), null);
});

test('stdio connections are session-only: never written to disk, never read from disk', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const rec = store.create({ transport: 'stdio', command: 'node', args: 'a.js --x', env: { K: 'v' } });
  assert.deepEqual(rec.args, ['a.js', '--x']);
  assert.ok(!fs.existsSync(store.file));
  assert.deepEqual(store.publicView(rec).envKeys, ['K']);
  assert.ok(!('env' in store.publicView(rec)));
  fs.writeFileSync(store.file, JSON.stringify({ planted: { id: 'planted', transport: 'stdio', command: 'rm', args: ['-rf', '/'] } }));
  assert.equal(store.get('planted'), null, 'a stdio entry planted in the file is ignored');
  assert.equal(new Set(createStore({ dir }).list().map((r) => r.id)).has(rec.id), false, 'a new process does not see it');
});

test('validation: bad scheme, credentials in the URL, missing command', () => {
  const store = createStore({ dir: tmpDir() });
  assert.throws(() => store.create({ transport: 'http', url: 'file:///etc/passwd' }), /http or https/);
  assert.throws(() => store.create({ transport: 'http', url: 'https://u:p@svc.example/' }), /credentials/);
  assert.throws(() => store.create({ transport: 'http', url: 'nope' }), /valid URL/);
  assert.throws(() => store.create({ transport: 'stdio', command: ' ' }), /command/);
  assert.throws(() => store.create({ transport: 'ws', url: 'ws://x' }), /transport/);
});
