// Credential refusal, one shape and one place at a time. This lab takes no credential: text that looks like one is refused
// wherever the sender can type it (labels, descriptions, names, aliases, ids, call arguments and everything inside a tool
// inputSchema), and it is never echoed in a response or a log line. A negative control sits beside every refusal, so a
// refusal can only come from the value, not from the shape of the request. Ping release claim of 2026-11-02, UNVERIFIED on our tenant.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BOUNDS, credentialLike, credentialRules, nameOk, RULE_NAMES, TOOL_NAME } from '../src/gateway/config.js';
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
  jwtNoSignature: ['eyJhbGciOi', 'eyJzdWIiOi', ''].join('.'),
  bearerLower: ['bearer', 'abcd1234'].join(' '),
  ghp: ['ghp', 'abcdefghijkl1234'].join('_'),
  xox: ['xox', 'b-1234567890-abcdefghij'].join(''),
  glued: ['tok', 'ghp', 'abcdefghijkl1234'].join('_'),
  hex: ['abcdef0123456789', 'abcdef0123456789'].join(''),
  basic: ['Basic', 'dXNlcjpwYXNzd29yZA=='].join(' '),
  assignment: ['pass', 'word=hunter22'].join(''),
};

const K = (prefix, rest) => prefix + rest; // joins at run time, so no fake key sits in the source for a secret scanner to flag

// Which rule fires on which shape, and ONLY that rule. Removing a rule, or narrowing it, fails the line that pins it.
const RULE_SHAPES = {
  jwt: [SHAPES.jwt, SHAPES.jwtNoSignature, 'eyJhbGciOi.eyJzdWIiOi.c2ln.extra'],
  bearer: [SHAPES.bearer, SHAPES.bearerLower, 'BEARER abcd1234', ['Bearer', 'abcd1234'].join('_'), ['bearer', 'abcd1234'].join('_'), ['Bearer', '', 'abcd1234'].join('  ')],
  'key-prefix': [
    SHAPES.prefixed, SHAPES.ghp, SHAPES.xox, SHAPES.glued, K('sk_', 'live_abcdefghijkl'), K('pk', '-abcdefghijklmn'), K('rk', '_abcdefghijklmn'), K('gho', '_abcdefghijkl1234'), K('ghs', '-abcdefghijkl1234'),
    K('xoxa', '-abcdefghijklmn'), K('xoxp', '-abcdefghijklmn'), K('xoxr', '-abcdefghijklmn'), K('xoxs', '-abcdefghijklmn'), K('x_sk', '-livekeyabcdef'), K('use:sk', '-livekeyabcdef'), K('(ghp', '_abcdefghijkl1234)'),
  ],
  akia: [SHAPES.akia, `key ${SHAPES.akia}.`, `x_${SHAPES.akia}`],
  'mixed-token': [SHAPES.long],
  hex: [SHAPES.hex, `${SHAPES.hex}${SHAPES.hex}`, `id ${SHAPES.hex} id`],
  basic: [SHAPES.basic, ['basic', 'dXNlcjpwYXNzd29yZA=='].join('_'), 'Basic YWJjZGVmZ2hpamts', 'Basic abcdefghijkl==', 'Basic abcdefghijklMnop'],
  assignment: [SHAPES.assignment, 'secret=abcd', 'api_key=abcd1234', 'API-KEY = abcd1234', 'apikey="abcd1234"', 'passwd=abcd', 'pwd=abcd', "db_password='hunter22'", 'SECRET = abcdef'],
};
const fromCodes = (...codes) => String.fromCharCode(...codes);

test('every credential rule is pinned by its own shapes: that rule fires, and no other', T, () => {
  assert.deepEqual(Object.keys(RULE_SHAPES).sort(), [...RULE_NAMES].sort(), 'a rule with no pinned shape');
  for (const [rule, shapes] of Object.entries(RULE_SHAPES)) {
    for (const v of shapes) assert.deepEqual(credentialRules(v), [rule], `${rule}: ${JSON.stringify(v)}`);
  }
});

test('credentialLike sees through look-alike and invisible characters (NFKC, then zero-width and other format characters removed)', T, () => {
  const key = 'sk-livekeyabcdef';
  assert.equal(credentialLike(key), true);
  // a zero-width space, joiner, non-joiner, word joiner, BOM and a soft hyphen inside the shape
  for (const cp of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]) {
    assert.equal(credentialLike(`${key.slice(0, 5)}${fromCodes(cp)}${key.slice(5)}`), true, `U+${cp.toString(16)} inside a key`);
    assert.equal(credentialLike(`Bea${fromCodes(cp)}rer abcd1234`), true, `U+${cp.toString(16)} inside Bearer`);
    assert.equal(credentialLike(`eyJhbGciOi.${fromCodes(cp)}eyJzdWIiOi.`), true, `U+${cp.toString(16)} inside a JWT`);
  }
  // full-width letters, digits and hyphen become plain ones under NFKC
  const wide = [...key].map((ch) => (ch === '-' ? fromCodes(0xff0d) : fromCodes(ch.charCodeAt(0) + 0xfee0))).join('');
  assert.notEqual(wide, key);
  assert.equal(credentialLike(wide), true, 'full-width key');
  assert.equal(credentialLike(`${fromCodes(0xff30)}ass${fromCodes(0xff57)}ord${fromCodes(0xff1d)}hunter22`), true, 'full-width password=');
  // control: the same characters in plain text that holds no shape
  assert.equal(credentialLike(`find${fromCodes(0x200b)}_customer`), false);
  assert.equal(credentialLike(`${fromCodes(0xff23)}ustomer lookup`), false);
});

test('a letter or digit in front of a prefix is not a key, an underscore or a symbol in front is', T, () => {
  for (const v of ['task-managerdashboard', 'risk-assessment-framework', 'disk_usage_report_statement', K('mask', '-abcdefghijklmnop'), K('xsk', '-livekeyabcdef'), K('9sk', '-livekeyabcdef'), K('taskghp', '_abcdefghijkl1234')]) assert.equal(credentialRules(v).includes('key-prefix'), false, v);
  for (const v of [K('_sk', '-livekeyabcdef'), K('a_sk', '-livekeyabcdef'), K('-sk', '-livekeyabcdef'), K('.sk', '-livekeyabcdef'), K(' sk', '-livekeyabcdef'), K('"sk', '-livekeyabcdef"'), K('token:ghp', '_abcdefghijkl1234'), K('AKIA_x_ghp', '_abcdefghijkl1234')]) assert.equal(credentialRules(v).includes('key-prefix'), true, v);
  // same for the other rules that use the lookbehind
  assert.equal(credentialRules(`xeyJhbGciOi.eyJzdWIiOi.`).includes('jwt'), false);
  assert.equal(credentialRules(`_eyJhbGciOi.eyJzdWIiOi.`).includes('jwt'), true);
  assert.equal(credentialRules(`xBearer abcd1234`).includes('bearer'), false);
  assert.equal(credentialRules(`xAKIAABCDEFGHIJKLMNOP`).includes('akia'), false);
  assert.equal(credentialRules(`AKIAABCDEFGHIJKLMNOPQ`).includes('akia'), false, 'a 21st character is not an access key id');
});

test('near misses that are plain text, with the rule each one stays below', T, () => {
  const plain = [
    'Basic authentication is required', 'Basic Authentication', 'basic information about the server', 'Basic usage example',
    'password', 'password=', 'password=ab', 'reset the password', 'the secret is kept elsewhere', 'secret: kept elsewhere', 'api key rotation',
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d', // 31 hex characters
    'bearer of bad news', 'Bearer tokens', 'Bearer_', 'eyJabc.def', 'AKIA1234', 'ghp_short', 'xoxb-short', 'sk-livekey',
    'get_customer_billing_statement', 'Look up one customer by name.',
  ];
  for (const v of plain) assert.deepEqual(credentialRules(v), [], JSON.stringify(v));
  assert.deepEqual(credentialRules(undefined), []);
  assert.deepEqual(credentialRules(42), []);
});

test('worst-case input (2000 characters) is decided quickly: no rule backtracks badly', T, () => {
  const bad = [
    'a'.repeat(2000), '0'.repeat(2000), 'A'.repeat(2000), 'Aa'.repeat(1000), 'Basic '.repeat(330), 'Basic aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '.repeat(40),
    'Bearer '.repeat(280), 'eyJ'.repeat(660), 'eyJabcd.'.repeat(250), 'password='.repeat(220), 'sk-'.repeat(660), 'a-'.repeat(1000), `${'a'.repeat(1990)}!`,
    ' '.repeat(2000), '\u200b'.repeat(1000),
  ];
  const t0 = performance.now();
  for (const v of bad) credentialLike(v);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

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
