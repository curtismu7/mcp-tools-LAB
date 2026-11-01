// Credential refusal, one shape and one place at a time. This lab takes no credential: text that looks like one is refused
// wherever the sender can type it (labels, descriptions, names, aliases, ids, call arguments and everything inside a tool
// inputSchema), and it is never echoed in a response or a log line. A negative control sits beside every refusal, so a
// refusal can only come from the value, not from the shape of the request. Ping release claim of 2026-11-02, UNVERIFIED on our tenant.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BOUNDS, credentialLike, nameOk, TOOL_NAME } from '../src/gateway/config.js';
import { freshConfig } from '../src/gateway/fixture.js';
import { startApp } from './helpers.js';

const T = { timeout: 120_000 };
const raw = { headers: { 'Content-Type': 'application/json' } };

// Fake credentials built from parts, one per detection rule, each matched by that rule alone. None is real.
const SHAPES = {
  jwt: ['eyJhbGciOi', 'eyJzdWIiOi', 'c2ln'].join('.'),
  bearer: ['Bearer', 'abcd1234'].join(' '),
  prefixed: ['sk', 'live', 'Abcdefgh1234567890XyZ'].join('-'),
  akia: ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  long: ['Abcdefghij1234567890', 'Abcdefghij12'].join(''),
};

test('credentialLike: each rule fires on its own shape, and near misses are not credentials', T, () => {
  for (const [name, v] of Object.entries(SHAPES)) assert.equal(credentialLike(v), true, `shape ${name}`);
  // the same shapes embedded in a sentence
  for (const [name, v] of Object.entries(SHAPES)) assert.equal(credentialLike(`see ${v} here`), true, `embedded ${name}`);
  const near = [
    'Bearer', 'Bearer short', 'bearer token', 'eyJ', 'eyJabc.def', 'sk-short', 'sk_', 'AKIA1234', 'akiaabcdefghijklmnop',
    'Abcdefghij1234567890Abcdefghij1', // 31 characters
    'abcdefghij1234567890abcdefghij12', // no capital letter
    'ABCDEFGHIJ1234567890ABCDEFGHIJ12', // no lower-case letter
    'Abcdefghijklmnopqrstuvwxyzabcdef', // no digit
    'get_customer_billing_statement', 'find_customer', 'Look up one customer by name.', '', 'x',
  ];
  for (const v of near) assert.equal(credentialLike(v), false, `near miss ${JSON.stringify(v)}`);
  for (const v of [undefined, null, 5, true, {}, [], ['x']]) assert.equal(credentialLike(v), false, 'only text can be a credential');
});

test('nameOk: a name that fits its pattern is still refused when it looks like a credential', T, () => {
  assert.equal(nameOk('find_customer', TOOL_NAME), true);
  assert.equal(nameOk('get_customer_billing_statement', TOOL_NAME), true);
  for (const k of ['jwt', 'prefixed', 'akia', 'long']) {
    assert.ok(TOOL_NAME.test(SHAPES[k]), `shape ${k} fits the tool-name pattern, so only the credential check can refuse it`);
    assert.equal(nameOk(SHAPES[k], TOOL_NAME), false, `name ${k}`);
  }
  assert.equal(nameOk(5, TOOL_NAME), false);
});

// Where a value can be placed. Each place edits a fresh config. `text` places are refused with the credential message.
const schemaOf = (c) => c.members[0].tools[0];
const PLACES = {
  'caller label': { text: true, max: 40, put: (c, v) => { c.callers[0].label = v; } },
  'tool description': { text: true, put: (c, v) => { schemaOf(c).description = `use ${v} here`; } },
  'inputSchema default': { text: true, put: (c, v) => { schemaOf(c).inputSchema = { type: 'object', properties: { a: { type: 'string', default: v } } }; } },
  'inputSchema property description': { text: true, put: (c, v) => { schemaOf(c).inputSchema = { type: 'object', properties: { a: { type: 'string', description: `use ${v}` } } }; } },
  'inputSchema enum item': { text: true, put: (c, v) => { schemaOf(c).inputSchema = { type: 'object', properties: { a: { type: 'string', enum: ['one', v] } } }; } },
  'inputSchema property key': { text: true, keyed: true, put: (c, v) => { schemaOf(c).inputSchema = { type: 'object', properties: { [v]: { type: 'string' } } }; } },
  'inputSchema top-level key': { text: true, keyed: true, put: (c, v) => { schemaOf(c).inputSchema = { type: 'object', [v]: 1 }; } },
  'inputSchema list inside a list': { text: true, put: (c, v) => { schemaOf(c).inputSchema = { type: 'object', examples: [[1, [v]]] }; } },
  'extra tool name': { text: false, fits: /^[A-Za-z_][A-Za-z0-9_.-]*$/, put: (c, v) => { c.members[0].tools.push({ name: v, description: 'extra' }); } },
  'extra member id': { text: false, fits: /^[a-z][a-z0-9-]{0,23}$/, put: (c, v) => { c.members.push({ id: v, alias: 'xtra', reachable: true, upstream: 'none', linkedCallers: [], toolFilter: [], tools: [], policy: [] }); } },
  'extra member alias': { text: false, fits: /^[a-z][a-z0-9-]{0,15}$/, put: (c, v) => { c.members.push({ id: 'xtra', alias: v, reachable: true, upstream: 'none', linkedCallers: [], toolFilter: [], tools: [], policy: [] }); } },
  'extra caller id': { text: false, fits: /^[a-z][a-z0-9-]{0,23}$/, put: (c, v) => { c.callers.push({ id: v, label: 'Extra' }); } },
};
const LOWER_PREFIXED = ['sk', 'livekeyabcdef'].join('-'); // lower case so it also fits id and alias patterns

test('every place a credential can be typed refuses it, never echoes it, and accepts a plain value in the same place', T, async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  const app = await startApp({ env: {} });
  let refused = 0;
  let controls = 0;
  try {
    const send = (route, config, extra = {}) => app.call('POST', `/api/gateway/${route}`, { caller: 'operator', config, ...extra });
    for (const [place, p] of Object.entries(PLACES)) {
      // negative control: the same edit with a plain value is accepted, so a refusal below is about the value alone
      const ctl = freshConfig(); p.put(ctl, p.fits ? 'plainvalue' : 'plain value');
      const rc = await send('list', ctl);
      assert.equal(rc.status, 200, `control for ${place}: ${rc.text.slice(0, 120)}`);
      controls += 1;
      const values = p.fits ? [...Object.values(SHAPES), LOWER_PREFIXED].filter((v) => p.fits.test(v)) : Object.values(SHAPES).filter((v) => !p.max || v.length <= p.max);
      assert.ok(values.length >= 1, `${place} has at least one shape that fits`);
      for (const v of values) {
        const c = freshConfig(); p.put(c, v);
        const r = await send('list', c);
        assert.equal(r.status, 400, `${place} accepted ${v.slice(0, 6)}...`);
        assert.equal(r.json.error, 'bad_config');
        if (p.text) assert.match(r.json.message, /credential/, `${place} refused for the wrong reason`);
        assert.ok(!r.text.includes(v), `${place} echoed the value`);
        refused += 1;
      }
    }
    // text places: every shape x every route (audit, scan, call and the direct view see the same normalized config)
    for (const v of Object.values(SHAPES)) {
      const c = freshConfig(); PLACES['inputSchema default'].put(c, v);
      for (const [route, extra] of [['audit', {}], ['scan', {}], ['call', { tool: 'crm__find_customer' }], ['list', { view: 'direct', member: 'crm' }]]) {
        const r = await send(route, c, extra);
        assert.equal(r.status, 400, `${route} accepted a credential in an inputSchema`);
        assert.ok(!r.text.includes(v), `${route} echoed the value`);
        refused += 1;
      }
    }
    assert.ok(refused >= 60 && controls === Object.keys(PLACES).length, `exercised ${refused} refusals and ${controls} controls`);
  } finally { Object.assign(console, orig); await app.close(); }
  for (const line of logs) for (const v of [...Object.values(SHAPES), LOWER_PREFIXED]) assert.ok(!line.includes(v), 'a log line repeated a credential');
});

test('a credential in the call arguments is refused and a plain argument is not (negative control)', T, async () => {
  const app = await startApp({ env: {} });
  try {
    const call = (args) => app.call('POST', '/api/gateway/call', { caller: 'operator', tool: 'crm__find_customer', arguments: args });
    assert.equal((await call({ name: 'Ada', nested: { list: ['a', 'b'] } })).status, 200);
    for (const v of Object.values(SHAPES)) {
      for (const args of [{ token: v }, { a: { b: [v] } }, { [v]: 1 }]) {
        const r = await call(args);
        assert.equal(r.status, 400);
        assert.ok(!r.text.includes(v));
      }
    }
    // a credential-shaped tool name in a call is refused and not echoed, on the aggregate and on the direct view
    for (const k of Object.keys(SHAPES)) {
      for (const body of [{ tool: SHAPES[k] }, { tool: `crm__${SHAPES[k]}` }, { view: 'direct', member: 'crm', tool: SHAPES[k] }]) {
        const r = await app.call('POST', '/api/gateway/call', { caller: 'operator', ...body });
        assert.ok(r.status === 400 || r.status === 403, `status ${r.status}`);
        assert.ok(!r.text.includes(SHAPES[k]), 'the tool name was echoed');
      }
    }
    // with no word character in front, the shape is recognised and the call is refused as a bad request
    for (const k of ['jwt', 'prefixed', 'akia', 'long']) {
      assert.equal((await app.call('POST', '/api/gateway/call', { caller: 'operator', view: 'direct', member: 'crm', tool: SHAPES[k] })).status, 400, `direct ${k}`);
    }
  } finally { await app.close(); }
});

test('a plain inputSchema with ordinary text is still accepted and comes back unchanged', T, async () => {
  const app = await startApp({ env: {} });
  try {
    const c = freshConfig();
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'Customer id', default: 'c-001', enum: ['c-001', 'c-002'] }, n: { type: 'integer', minimum: 0 }, tags: { type: 'array', items: { type: 'string' } } } };
    schemaOf(c).inputSchema = schema;
    const r = await app.call('POST', '/api/gateway/list', { caller: 'operator', config: c });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tools.find((t) => t.name === 'crm__find_customer').inputSchema, schema);
  } finally { await app.close(); }
});

test('hostile inputSchema: too deep, too many values, too long a string or key are refused cleanly; __proto__ is data', T, async () => {
  const app = await startApp({ env: {} });
  try {
    const post = (config) => app.call('POST', '/api/gateway/list', { caller: 'operator', config });
    const nest = (n) => { let o = 'leaf'; for (let i = 0; i < n; i += 1) o = { k: o }; return o; };
    const withSchema = (inputSchema) => { const c = freshConfig(); schemaOf(c).inputSchema = inputSchema; return c; };
    assert.equal((await post(withSchema({ type: 'object', x: nest(BOUNDS.schemaDepth - 3) }))).status, 200, 'control: nesting inside the bound');
    for (const bad of [
      { type: 'object', x: nest(BOUNDS.schemaDepth + 2) },
      { type: 'object', x: nest(2000) },
      { type: 'object', x: Array.from({ length: BOUNDS.schemaNodes + 1 }, () => 1) },
      { type: 'object', x: 'a '.repeat(600) },
      { type: 'object', [`${'k'.repeat(101)}`]: 1 },
    ]) {
      const r = await post(withSchema(bad));
      assert.equal(r.status, 400, `expected a clean refusal, got ${r.status}`);
      assert.equal(r.json.error, 'bad_config');
    }
    assert.equal((await post(withSchema({ type: 'object', x: Array.from({ length: BOUNDS.schemaNodes - 10 }, () => 1) }))).status, 200, 'control: many values inside the bound');
    // an own "__proto__" key in the schema is plain data: no prototype write, no crash
    const body = JSON.stringify({ caller: 'operator', config: freshConfig() }).replace('"inputSchema":{', '"inputSchema":{"__proto__":{"polluted":true},');
    assert.ok(body.includes('"__proto__"'));
    const r = await app.call('POST', '/api/gateway/list', body, { ...raw, raw: true });
    assert.ok(r.status === 200 || r.status === 400, `status ${r.status}`);
    assert.equal({}.polluted, undefined);
  } finally { await app.close(); }
});
