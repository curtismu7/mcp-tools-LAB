// The confirm hash in isolation (the full flow is in api.test.js). argsHash binds connection, method, name and the
// canonical arguments, so a stale or swapped preview can never authorise a different call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { argsHash, canonicalJson } from '../src/canonical.js';

const base = { connectionId: 'c1', method: 'tools/call', name: 'get_time', args: { tz: 'UTC', n: [1, 2], o: { b: 1, a: 2 } } };
const h = (over = {}) => argsHash({ ...base, ...over });

test('argsHash is a 64-hex sha256 and is deterministic', () => {
  assert.match(h(), /^[0-9a-f]{64}$/);
  assert.equal(h(), h());
});

test('argsHash does not depend on key order, at any depth', () => {
  assert.equal(h({ args: { o: { a: 2, b: 1 }, n: [1, 2], tz: 'UTC' } }), h());
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
});

test('argsHash changes when any value, key, array order, type, connection, method or tool name changes', () => {
  const seen = new Set([h()]);
  const variants = [
    { args: { ...base.args, tz: 'UTC ' } },
    { args: { ...base.args, tz: 'utc' } },
    { args: { ...base.args, extra: 1 } },
    { args: { tz: 'UTC', n: [2, 1], o: base.args.o } },
    { args: { tz: 'UTC', n: [1, 2], o: { b: 1, a: 3 } } },
    { args: { tz: 'UTC', n: ['1', 2], o: base.args.o } },
    { args: { tz: 'UTC', n: [1, 2], o: { b: 1, a: 2, z: null } } },
    { connectionId: 'c2' },
    { method: 'logging/setLevel' },
    { name: 'get_time2' },
  ];
  for (const v of variants) { const x = h(v); assert.ok(!seen.has(x), `collision for ${JSON.stringify(v)}`); seen.add(x); }
});

test('unicode stance: no normalisation. Bytes the operator saw are the bytes hashed, so NFC and NFD differ, and so do invisible characters', () => {
  const nfc = 'café';
  const nfd = 'café';
  assert.notEqual(nfc, nfd);
  assert.notEqual(h({ args: { q: nfc } }), h({ args: { q: nfd } }));
  assert.notEqual(h({ args: { q: 'ab' } }), h({ args: { q: 'a​b' } }), 'a zero-width character changes the hash');
  assert.equal(h({ args: { q: nfc } }), h({ args: { q: 'café' } }));
  // Keys are sorted by UTF-16 code unit, the same on every machine.
  assert.equal(canonicalJson({ 'é': 1, z: 2, a: 3 }), '{"a":3,"z":2,"é":1}');
});

test('missing arguments hash as an empty object', () => {
  assert.equal(h({ args: undefined }), h({ args: {} }));
  assert.equal(canonicalJson(undefined), 'null');
});
