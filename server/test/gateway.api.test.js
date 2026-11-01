// The simulated gateway over HTTP: wire shape, hostile input, credentials never echoed, zero outbound, mock-only mode,
// the scan of a filtered listing, and how every name is tagged. Ping release claim of 2026-11-02, UNVERIFIED on our tenant.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { BOUNDS } from '../src/gateway/config.js';
import { freshConfig } from '../src/gateway/fixture.js';
import { BANNER, PROVENANCE, TAG_TEXT } from '../src/gateway/provenance.js';
import { startApp } from './helpers.js';
import { installGuard } from './netguard.js';

const T = { timeout: 60_000 };
const raw = { headers: { 'Content-Type': 'application/json' } };
const EXCERPT = JSON.parse(fs.readFileSync(new URL('./fixtures/swagger-excerpt-2026-10-31.json', import.meta.url), 'utf8'));

// A fake credential, built from parts so no real-looking secret sits in the source.
const FAKE_JWT = ['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2ln'].join('.');
const FAKE_KEY = ['sk', 'live', 'Abcdefgh1234567890XyZ'].join('-');

async function withApp(env, fn) {
  const app = await startApp({ env });
  try { return await fn(app); } finally { await app.close(); }
}
const post = (app, p, body) => app.call('POST', `/api/gateway/${p}`, body);
const tools = (r) => r.json.tools.map((t) => t.name);

test('GET /api/gateway/default returns the lab config, the banner text and the tag vocabulary', T, async () => {
  await withApp({}, async (app) => {
    const r = await app.call('GET', '/api/gateway/default');
    assert.equal(r.status, 200);
    assert.equal(r.json.claim.banner, BANNER);
    assert.equal(r.json.claim.live, false);
    assert.deepEqual(r.json.config, freshConfig());
    assert.deepEqual(r.json.tags, TAG_TEXT);
    assert.equal(r.json.provenance.length, PROVENANCE.length);
  });
});

test('list: per caller, real counts, and nothing in the body says what was hidden', T, async () => {
  await withApp({}, async (app) => {
    const counts = {};
    for (const caller of ['analyst', 'operator', 'guest']) {
      const r = await post(app, 'list', { caller });
      assert.equal(r.status, 200);
      counts[caller] = r.json.tools.length;
      assert.equal(r.json.claim.banner, BANNER);
      assert.doesNotMatch(JSON.stringify({ ...r.json, tools: undefined }), /export_all|edit_page|refund_payment|hidden|denied/i, 'members and claim carry no tool names and no hidden count');
    }
    assert.deepEqual(counts, { analyst: 4, operator: 6, guest: 1 });
    const direct = await post(app, 'list', { caller: 'operator', view: 'direct', member: 'crm' });
    assert.deepEqual(tools(direct), ['find_customer', 'update_customer', 'export_all']);
  });
});

test('call: a hidden tool is refused by name with 403 and the same words as an unknown one; an entitled one passes', T, async () => {
  await withApp({}, async (app) => {
    const hidden = await post(app, 'call', { caller: 'operator', tool: 'crm__export_all' });
    const unknown = await post(app, 'call', { caller: 'operator', tool: 'crm__nothing_here' });
    const ok = await post(app, 'call', { caller: 'operator', tool: 'crm__update_customer', arguments: { id: 'c-1' } });
    assert.equal(hidden.status, 403); assert.equal(unknown.status, 403); assert.equal(ok.status, 200);
    assert.equal(hidden.json.message, unknown.json.message);
    assert.equal(hidden.json.error, 'tool_not_available');
    assert.match(hidden.json.demoTrace.note, /Demo only/);
    assert.equal(hidden.json.demoTrace.steps[0].layer, 'aggregate-cap');
    assert.match(ok.json.result.content[0].text, /nothing was run/);
    assert.equal((await post(app, 'call', { caller: 'operator', view: 'direct', member: 'crm', tool: 'export_all' })).status, 200, 'negative control: direct follows the member policy');
  });
});

test('audit and scan routes: the audit names hidden tools (labelled demo only); the scan says it covers only what the caller sees', T, async () => {
  await withApp({}, async (app) => {
    const a = await post(app, 'audit', { caller: 'operator' });
    assert.match(a.json.demoOnly, /never sees/);
    assert.equal(a.json.rows.length, 8);
    assert.equal(a.json.rows.find((r) => r.name === 'crm__export_all').layer, 'aggregate-cap');

    // Via the aggregate the operator never sees the planted tool, so the scan is clean. Directly it does, and it is flagged.
    const viaAgg = await post(app, 'scan', { caller: 'operator' });
    const viaMember = await post(app, 'scan', { caller: 'operator', view: 'direct', member: 'crm' });
    const analystMember = await post(app, 'scan', { caller: 'analyst', view: 'direct', member: 'crm' });
    assert.equal(viaAgg.json.report.summary.total, 0);
    assert.ok(viaMember.json.report.summary.high >= 1, 'the planted instruction is found where the caller can see it');
    assert.equal(analystMember.json.report.summary.total, 0, 'the same member scanned as a caller who cannot see the tool is clean');
    assert.match(viaAgg.json.report.notes[0], /covers only the 6 tool\(s\) that Operator sees/);
    assert.match(analystMember.json.report.notes[0], /covers only the 1 tool\(s\) that Analyst sees/);
    assert.match(analystMember.json.report.notes[0], /not a clean result for any other caller/);
    assert.ok(viaAgg.json.report.limits.some((l) => l.id === 'filtered-listing'));
    assert.equal(viaAgg.json.report.scanner.enforcement, 'none');
  });
});

test('Limits: /api/rules carries the filtered-listing limit with the claim label', T, async () => {
  await withApp({}, async (app) => {
    const l = (await app.call('GET', '/api/rules')).json.limits.find((x) => x.id === 'filtered-listing');
    assert.ok(l);
    assert.match(l.text, /only what that caller sees/);
    assert.match(l.text, /UNVERIFIED on our tenant/);
  });
});

test('hostile input: bad shapes are 400 with a fixed message, never a 500, never an echo', T, async () => {
  await withApp({}, async (app) => {
    const cases = [
      { caller: 'analyst', view: 'sideways' },
      { caller: '__proto__' }, { caller: 'constructor' }, { caller: ['analyst'] }, { caller: 'nobody' },
      { caller: 'analyst', member: 'crm' }, { caller: 'analyst', view: 'direct' }, { caller: 'analyst', view: 'direct', member: '__proto__' },
      { caller: 'analyst', extra: 1 }, { caller: 'analyst', config: 5 }, { caller: 'analyst', config: [] }, { caller: 'analyst', config: { schema: 'nope' } },
    ];
    for (const body of cases) {
      const r = await post(app, 'list', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.claim.banner, BANNER);
      assert.ok(r.text.length < 400);
    }
    for (const p of ['call', 'audit', 'scan', 'list']) assert.equal((await app.call('POST', `/api/gateway/${p}`, '[1,2', { ...raw, raw: true })).status, 400);
    assert.equal((await post(app, 'call', { caller: 'analyst', tool: 5 })).status, 400);
    assert.equal((await post(app, 'call', { caller: 'analyst', tool: '__proto__' })).status, 400, 'a name with no alias is malformed');
    assert.equal((await post(app, 'call', { caller: 'analyst', tool: 'crm__find_customer', arguments: [1] })).status, 400);
    assert.equal((await post(app, 'call', { caller: 'analyst', tool: 'crm__find_customer', arguments: { a: { b: { c: { d: { e: { f: 1 } } } } } } })).status, 400, 'too deep');
  });
});

test('hostile input: bounds on size, counts, duplicates and dangling names; unknown fields refused', T, async () => {
  await withApp({}, async (app) => {
    const bad = async (edit, why) => {
      const w = freshConfig(); edit(w);
      const r = await post(app, 'list', { caller: 'analyst', config: w });
      assert.equal(r.status, 400, why);
      assert.equal(r.json.error, 'bad_config', why);
    };
    await bad((w) => { w.members[0].tools = Array.from({ length: BOUNDS.tools + 1 }, (_, i) => ({ name: `t${i}`, description: 'x' })); w.members[0].toolFilter = []; w.members[0].policy = []; w.cap = []; }, 'too many tools');
    await bad((w) => { w.callers = Array.from({ length: BOUNDS.callers + 1 }, (_, i) => ({ id: `c${i}`, label: 'x' })); }, 'too many callers');
    await bad((w) => { w.members.push(...Array.from({ length: BOUNDS.members }, (_, i) => ({ ...structuredClone(w.members[0]), id: `m${i}`, alias: `m${i}` }))); }, 'too many members');
    await bad((w) => { w.members[1].alias = 'crm'; for (const g of w.cap) g.tools = g.tools.map((t) => t.replace('bill__', 'crm__')); }, 'duplicate alias (the cap is renamed to match, so only the duplicate is wrong)');
    await bad((w) => { w.members[1].alias = 'a__b'; }, 'alias with double underscore');
    await bad((w) => { w.members[0].tools[1].name = 'find_customer'; }, 'duplicate tool');
    await bad((w) => { w.members[0].policy[0].tools.push('ghost'); }, 'policy names a missing tool');
    await bad((w) => { w.cap[0].tools.push('crm__ghost'); }, 'cap names a missing tool');
    await bad((w) => { w.cap.push({ caller: 'ghost', tools: [] }); }, 'cap names a missing caller');
    await bad((w) => { w.cap.push({ caller: 'analyst', tools: [] }); }, 'caller twice');
    await bad((w) => { w.members[0].color = 'red'; }, 'unknown member field');
    await bad((w) => { w.members[0].tools[0].description = 'x'.repeat(1001); }, 'long description');
    await bad((w) => { w.members[0].reachable = 'yes'; }, 'reachable must be boolean');
    await bad((w) => { w.members[0].upstream = 'sometimes'; }, 'upstream word');
    await bad((w) => { w.members[0].tools[0].inputSchema = 'x'; }, 'schema type');
    await bad((w) => { w.members[0].tools[0].inputSchema = { type: 'object', properties: { a: 'x'.repeat(5000) } }; }, 'big schema');
    const big = await app.call('POST', '/api/gateway/list', JSON.stringify({ caller: 'analyst', pad: 'x'.repeat(70_000) }), { ...raw, raw: true });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'too_large');
  });
});

test('hostile input: a prototype-looking tool name works end to end and pollutes nothing', T, async () => {
  await withApp({}, async (app) => {
    const w = freshConfig();
    w.members[2].tools.push({ name: '__proto__', description: 'x' }, { name: 'constructor', description: 'y' });
    w.members[2].toolFilter.push('__proto__', 'constructor');
    w.members[2].policy.find((g) => g.caller === 'operator').tools.push('__proto__', 'constructor');
    w.cap.find((g) => g.caller === 'operator').tools.push('wiki____proto__', 'wiki__constructor');
    const l = await post(app, 'list', { caller: 'operator', config: w });
    assert.deepEqual(tools(l).filter((n) => n.startsWith('wiki__')), ['wiki__search_pages', 'wiki____proto__', 'wiki__constructor']);
    assert.equal((await post(app, 'call', { caller: 'operator', config: w, tool: 'wiki____proto__' })).status, 200);
    assert.equal((await post(app, 'call', { caller: 'analyst', config: w, tool: 'wiki__constructor' })).status, 403);
    // JSON with an own "__proto__" key at the top level is an unexpected field, not a prototype write
    const evil = await app.call('POST', '/api/gateway/list', '{"caller":"analyst","__proto__":{"polluted":true}}', { ...raw, raw: true });
    assert.equal(evil.status, 400);
    assert.equal({}.polluted, undefined);
  });
});

test('a typed credential is never echoed: refused or ignored in every field, and absent from every response and the log', T, async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    await withApp({}, async (app) => {
      const secrets = [FAKE_JWT, FAKE_KEY, `Bearer ${FAKE_KEY}`];
      const seen = [];
      const note = (r) => seen.push(r.text);
      for (const s of secrets) {
        const w1 = freshConfig(); w1.callers[0].label = s;
        const w2 = freshConfig(); w2.members[0].tools[0].description = `use ${s} here`;
        const w3 = freshConfig(); w3.members[0].tools[0].name = s.slice(0, 60);
        const w4 = freshConfig(); w4.members[0].alias = s.slice(0, 16);
        for (const w of [w1, w2, w3, w4]) { const r = await post(app, 'list', { caller: 'analyst', config: w }); note(r); assert.equal(r.status, 400); }
        for (const body of [
          { caller: 'analyst', tool: s }, { caller: 'analyst', tool: 'crm__find_customer', arguments: { token: s } },
          { caller: 'analyst', tool: 'crm__find_customer', arguments: { [s]: 1 } }, { caller: s }, { caller: 'analyst', view: s }, { caller: 'analyst', member: s },
          { caller: 'analyst', [s]: 1 }, { caller: 'analyst', config: { schema: s } },
        ]) for (const p of ['call', 'list', 'audit', 'scan']) { const r = await post(app, p, body); note(r); assert.ok(r.status >= 400 && r.status < 500, `${p} ${r.status}`); }
        // a header token is not read and not echoed either
        const r = await app.call('POST', '/api/gateway/list', { caller: 'analyst' }, { headers: { Authorization: `Bearer ${s}` } });
        note(r); assert.equal(r.status, 200);
        // a path or query is not echoed
        note(await app.call('GET', `/api/gateway/${encodeURIComponent(s)}?t=${encodeURIComponent(s)}`));
      }
      assert.ok(seen.length > 50, `exercised ${seen.length} responses`);
      for (const text of seen) for (const s of secrets) assert.ok(!text.includes(s) && !text.includes(s.slice(0, 20)), 'a response repeated a credential');
    });
  } finally { Object.assign(console, orig); }
  for (const line of logs) for (const s of [FAKE_JWT, FAKE_KEY]) assert.ok(!line.includes(s.slice(0, 20)), 'a log line repeated a credential');
});

test('a credential-shaped string that is a legitimate tool name pattern is not over-matched', T, async () => {
  await withApp({}, async (app) => {
    const w = freshConfig();
    w.members[0].tools.push({ name: 'get_customer_billing_statement', description: 'ok' });
    w.members[0].toolFilter.push('get_customer_billing_statement');
    assert.equal((await post(app, 'list', { caller: 'analyst', config: w })).status, 200);
  });
});

test('netguard: every gateway route, in normal and in mock-only mode, makes zero outbound connections, DNS lookups or child processes', T, async () => {
  for (const env of [{}, { MOCK_ONLY: '1' }]) {
    const g = installGuard();
    const app = await startApp({ env });
    try {
      g.allow(app.port);
      let n = 0;
      const hit = async (m, p, b) => { const r = await app.call(m, p, b); n += 1; assert.ok(r.status < 500, `${m} ${p} ${r.status}`); return r; };
      await hit('GET', '/api/gateway/default');
      for (const caller of ['analyst', 'operator', 'guest']) {
        for (const p of ['list', 'audit', 'scan']) { await hit('POST', `/api/gateway/${p}`, { caller }); await hit('POST', `/api/gateway/${p}`, { caller, view: 'direct', member: 'billing' }); }
        await hit('POST', '/api/gateway/call', { caller, tool: 'crm__export_all' });
        await hit('POST', '/api/gateway/call', { caller, view: 'direct', member: 'crm', tool: 'export_all' });
      }
      await hit('POST', '/api/gateway/list', { caller: '__proto__' });
      await hit('POST', '/api/gateway/call', { caller: 'analyst', tool: 'http://192.0.2.1/x' });
      assert.ok(n >= 25, `exercised ${n} requests`);
      const ok = await hit('POST', '/api/gateway/list', { caller: 'operator' });
      assert.equal(ok.status, 200, 'the routes work in this mode');
    } finally { g.uninstall(); await app.close(); }
    assert.deepEqual(g.attempts, [], `no blocked attempt (env ${JSON.stringify(env)})`);
  }
});

test('netguard self-check for this file: a gateway code path that did try the network would be caught', T, async () => {
  const g = installGuard();
  try {
    await assert.rejects(fetch('http://192.0.2.1:4769/', { redirect: 'error' }));
    assert.ok(g.attempts.length >= 1);
  } finally { g.uninstall(); }
});

test('mock-only mode: the gateway routes are served, same-origin writes are still required, and the host check applies', T, async () => {
  await withApp({ MOCK_ONLY: '1' }, async (app) => {
    assert.equal((await post(app, 'list', { caller: 'operator' })).json.tools.length, 6);
    const noOrigin = await app.call('POST', '/api/gateway/list', { caller: 'operator' }, { origin: null });
    assert.equal(noOrigin.status, 403);
    const other = await app.call('POST', '/api/gateway/list', { caller: 'operator' }, { origin: 'http://evil.invalid' });
    assert.equal(other.status, 403);
    // fetch cannot set Host, so a raw request does it: a rebinding name must be refused before the gateway runs
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: app.port, path: '/api/gateway/default', headers: { Host: 'rebind.invalid' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  });
});

test('provenance: every name carries one of the four tags, and the swagger-tagged names are in the committed swagger excerpt', T, () => {
  const tags = new Set(Object.keys(TAG_TEXT));
  assert.deepEqual([...tags].sort(), ['deck', 'invented', 'reading', 'swagger']);
  assert.equal(TAG_TEXT.swagger, 'console swagger name, 2026-10-31, schema only');
  for (const p of PROVENANCE) { assert.ok(tags.has(p.tag), p.name); assert.ok(p.note.length > 10); }
  const defs = EXCERPT.definitions;
  const member = Object.keys(defs.modelMcpAggregateMember.properties);
  assert.deepEqual(member.sort(), ['Alias', 'AppRef', 'ToolFilter']);
  assert.deepEqual(Object.keys(defs.modelMcpAggregateMembers.properties), ['Members']);
  assert.ok(EXCERPT['modelMcpAppConfig.Members'].$ref.endsWith('modelMcpAggregateMembers'));
  assert.equal(EXCERPT['present_on_2026-10-26'], true, 'these names are not new in the 2026-10-31 diff');
  const swaggerTagged = PROVENANCE.filter((p) => p.tag === 'swagger').map((p) => p.name);
  for (const n of ['AppRef', 'Alias', 'ToolFilter', 'Members', 'mcp-aggregate', 'alias__tool naming']) assert.ok(swaggerTagged.includes(n), `${n} is tagged swagger`);
  const exc = JSON.stringify(EXCERPT);
  assert.ok(exc.includes('mcp-aggregate') && exc.includes('<Alias>__<tool>'), 'the excerpt carries the AppType value and the naming text');
  // The two claims with no swagger field are never tagged swagger, and no field name is invented for them.
  for (const claim of ['entitlement-aware discovery', 'aggregate policy cap', 'cap enforced twice', 'removed from tools/list and refused by name']) {
    const p = PROVENANCE.find((x) => x.name === claim);
    assert.ok(p, claim);
    assert.ok(p.tag === 'deck' || p.tag === 'invented', `${claim} must be a deck claim or lab-invented`);
  }
  assert.ok(PROVENANCE.some((p) => /NonHumanIdentity/.test(p.note) && /Federated Identity is a display name only/.test(p.note)));
  const props = Object.values(defs).flatMap((d) => Object.keys(d.properties || {}));
  assert.ok(!props.some((k) => /cap|entitle|discover/i.test(k)), 'no swagger property in the excerpt could be mistaken for the cap or entitlement');
});

test('provenance (optional full check): no property of any Mcp or Aggregate definition in the full swagger is a cap or entitlement field', { ...T, skip: !process.env.SWAGGER_FILE && 'SKIPPED: set SWAGGER_FILE to the 2026-10-31 swagger json' }, () => {
  const full = JSON.parse(fs.readFileSync(process.env.SWAGGER_FILE, 'utf8'));
  const hits = Object.entries(full.definitions).filter(([k]) => /mcp|aggregate/i.test(k)).flatMap(([k, d]) => Object.keys(d.properties || {}).filter((p) => /^(Cap([A-Z]|$)|Entitle|Visib|Hidden)/.test(p)).map((p) => `${k}.${p}`));
  assert.deepEqual(hits, []);
  for (const k of ['modelMcpAggregateMember', 'modelMcpAggregateMembers']) assert.deepEqual(full.definitions[k], EXCERPT.definitions[k]);
});
