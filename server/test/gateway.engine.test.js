// Level 1 tests for the simulated gateway (Ping release claim of 2026-11-02, UNVERIFIED on our tenant). Real counts,
// each row of the test plan (prompt section 9: MCP Aggregate; MCP Catalog entitlement part) with a negative control.
// The engine is pure, so these call it directly; gateway.api.test.js drives the same engine over HTTP.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../src/gateway/config.js';
import { freshConfig } from '../src/gateway/fixture.js';
import { LAYERS, REFUSAL, audit, callAggregate, callMember, listAggregate, listMember, stageEntry, stageHop } from '../src/gateway/sim.js';

const T = { timeout: 30_000 };
const build = (edit) => { const w = freshConfig(); edit?.(w); return normalizeConfig(w); };
const names = (l) => l.tools.map((t) => t.name);
const member = (cfg, id) => cfg.members.find((m) => m.id === id);
const grant = (list, caller) => list.find((g) => g.caller === caller);

test('row MCP Aggregate: one listing, every name prefixed by its alias (real counts)', T, () => {
  const cfg = build();
  const op = listAggregate(cfg, 'operator');
  assert.equal(op.tools.length, 6);
  assert.deepEqual(names(op), ['crm__find_customer', 'crm__update_customer', 'bill__get_invoice', 'bill__list_payments', 'bill__refund_payment', 'wiki__search_pages']);
  for (const t of op.tools) assert.match(t.name, /^(crm|bill|wiki)__[a-z_]+$/);
  assert.equal(listAggregate(cfg, 'analyst').tools.length, 4);
  assert.equal(listAggregate(cfg, 'guest').tools.length, 1);
  // negative control: a member used directly is not prefixed
  assert.deepEqual(names(listMember(cfg, member(cfg, 'crm'), 'operator')), ['find_customer', 'update_customer', 'export_all']);
});

test('row MCP Aggregate: the alias is what prefixes (rename it and the names follow)', T, () => {
  const cfg = build((w) => { w.members[1].alias = 'pay'; w.cap = w.cap.map((g) => ({ ...g, tools: g.tools.map((t) => t.replace(/^bill__/, 'pay__')) })); });
  assert.equal(names(listAggregate(cfg, 'operator')).filter((n) => n.startsWith('pay__')).length, 3);
  assert.equal(names(listAggregate(cfg, 'operator')).filter((n) => n.startsWith('bill__')).length, 0);
});

test('row MCP Aggregate: a tool the member allows but the cap denies is hidden and refused (counts: 3 in the member, 2 through the aggregate)', T, () => {
  const cfg = build();
  const crm = member(cfg, 'crm');
  assert.equal(listMember(cfg, crm, 'operator').tools.length, 3, 'the member itself allows all three');
  const viaAgg = names(listAggregate(cfg, 'operator')).filter((n) => n.startsWith('crm__'));
  assert.deepEqual(viaAgg, ['crm__find_customer', 'crm__update_customer']);
  const r = callAggregate(cfg, 'operator', 'crm__export_all');
  assert.equal(r.ok, false);
  assert.equal(r.message, REFUSAL);
  assert.equal(r.trace[0].layer, 'aggregate-cap');
  // negative control: widen the cap and the same tool is listed and callable
  const wide = build((w) => grant(w.cap, 'operator').tools.push('crm__export_all'));
  assert.ok(names(listAggregate(wide, 'operator')).includes('crm__export_all'));
  assert.equal(callAggregate(wide, 'operator', 'crm__export_all').ok, true);
});

test('row MCP Aggregate: the cap only removes. A tool the member denies stays hidden even if the cap allows it', T, () => {
  const cfg = build((w) => grant(w.cap, 'analyst').tools.push('crm__export_all')); // the analyst is not entitled to it in the member
  assert.ok(!names(listAggregate(cfg, 'analyst')).includes('crm__export_all'));
  const r = callAggregate(cfg, 'analyst', 'crm__export_all');
  assert.equal(r.ok, false);
  assert.equal(r.trace[0].layer, 'member-policy');
});

test('row MCP Aggregate: the cap is enforced again at the member hop, on its own', T, () => {
  const cfg = build();
  const crm = member(cfg, 'crm');
  // The hop alone, as if the entry check had been skipped (a stale listing, a routing slip): it must still refuse.
  assert.equal(stageHop(cfg, crm, 'export_all', 'operator'), 'aggregate-cap');
  assert.equal(stageHop(cfg, crm, 'update_customer', 'operator'), null, 'negative control: an allowed tool passes the hop');
  assert.equal(stageHop(cfg, crm, 'update_customer', 'analyst'), 'member-policy', 'the member own policy is applied at the hop too');
  const down = build((w) => { w.members[0].reachable = false; });
  assert.equal(stageHop(down, member(down, 'crm'), 'find_customer', 'analyst'), 'unreachable');
  // The entry check alone refuses the same cap-denied tool.
  assert.equal(stageEntry(cfg, crm, 'export_all', 'operator'), 'aggregate-cap');
  // The whole call refuses at the first stage that applies and reports a passed entry when only the hop refuses.
  assert.deepEqual(callAggregate(cfg, 'operator', 'crm__export_all').trace.map((s) => s.stage), ['entry']);
});

test('row MCP Aggregate: the entry check also covers what the hop does not (ToolFilter and per-user sign-in)', T, () => {
  const cfg = build();
  const wiki = member(cfg, 'wiki');
  // wiki.edit_page is outside the ToolFilter: the member would allow it and the cap does not mention it.
  assert.equal(stageHop(cfg, wiki, 'edit_page', 'operator'), 'aggregate-cap');
  const looser = build((w) => grant(w.cap, 'operator').tools.push('wiki__edit_page'));
  assert.equal(stageHop(looser, member(looser, 'wiki'), 'edit_page', 'operator'), null, 'the hop alone would let it through');
  assert.equal(stageEntry(looser, member(looser, 'wiki'), 'edit_page', 'operator'), 'tool-filter');
  assert.equal(callAggregate(looser, 'operator', 'wiki__edit_page').ok, false);
  assert.equal(stageEntry(cfg, member(cfg, 'billing'), 'get_invoice', 'guest'), 'upstream-sign-in');
});

test('row MCP Aggregate: an unreachable member is reported, not silently dropped', T, () => {
  const down = build((w) => { w.members[0].reachable = false; });
  const l = listAggregate(down, 'operator');
  assert.deepEqual(l.members, [{ alias: 'crm', status: 'unreachable' }, { alias: 'bill', status: 'ok' }, { alias: 'wiki', status: 'ok' }]);
  assert.equal(l.members.length, 3, 'all three members are still reported');
  assert.equal(l.tools.length, 4, 'its two listed tools are gone and nothing else is');
  assert.equal(names(l).filter((n) => n.startsWith('crm__')).length, 0);
  assert.equal(callAggregate(down, 'operator', 'crm__find_customer').trace[0].layer, 'unreachable');
  assert.deepEqual(listMember(down, member(down, 'crm'), 'operator').members, [{ alias: 'crm', status: 'unreachable' }]);
  // negative control: reachable again
  const up = listAggregate(build(), 'operator');
  assert.deepEqual(up.members.map((m) => m.status), ['ok', 'ok', 'ok']);
  assert.equal(up.tools.length, 6);
});

test('row MCP Aggregate: per-user upstream sign-in, reported as needed until the caller is linked', T, () => {
  const l = listAggregate(build(), 'guest');
  assert.deepEqual(l.members.find((m) => m.alias === 'bill'), { alias: 'bill', status: 'needs-upstream-sign-in' });
  assert.equal(names(l).filter((n) => n.startsWith('bill__')).length, 0);
  assert.equal(callAggregate(build(), 'guest', 'bill__get_invoice').trace[0].layer, 'upstream-sign-in');
  // negative control: link the guest and the guest policy and cap now give one billing tool
  const linked = build((w) => { w.members[1].linkedCallers.push('guest'); grant(w.cap, 'guest').tools.push('bill__get_invoice'); });
  assert.deepEqual(names(listAggregate(linked, 'guest')), ['bill__get_invoice', 'wiki__search_pages']);
  // and the requirement is the switch: with upstream none, no link is needed
  const open = build((w) => { w.members[1].upstream = 'none'; grant(w.cap, 'guest').tools.push('bill__get_invoice'); });
  assert.ok(names(listAggregate(open, 'guest')).includes('bill__get_invoice'));
});

test('row MCP Aggregate (negative control): the same tool through the member directly follows the member own policy', T, () => {
  const cfg = build();
  const crm = member(cfg, 'crm');
  assert.equal(callAggregate(cfg, 'operator', 'crm__export_all').ok, false, 'refused through the aggregate (cap)');
  const direct = callMember(cfg, crm, 'operator', 'export_all');
  assert.equal(direct.ok, true, 'allowed directly: the member policy allows the operator');
  assert.equal(callMember(cfg, crm, 'analyst', 'export_all').ok, false, 'and refused directly for a caller the member policy does not name');
  assert.ok(listMember(cfg, crm, 'operator').tools.some((t) => t.name === 'export_all'));
  // The member ignores the aggregate ToolFilter and cap, and ignores nothing of its own.
  assert.ok(listMember(cfg, member(cfg, 'wiki'), 'operator').tools.some((t) => t.name === 'edit_page'));
});

test('direct use of a member: an unreachable member and a missing upstream sign-in are reported and refused there too', T, () => {
  const down = build((w) => { w.members[0].reachable = false; });
  assert.deepEqual(listMember(down, member(down, 'crm'), 'operator').tools, []);
  assert.equal(callMember(down, member(down, 'crm'), 'operator', 'find_customer').trace[0].layer, 'unreachable');
  const cfg = build();
  const billing = member(cfg, 'billing');
  const guest = listMember(cfg, billing, 'guest');
  assert.deepEqual(guest.members, [{ alias: 'bill', status: 'needs-upstream-sign-in' }]);
  assert.deepEqual(guest.tools, [], 'the member policy lists one tool for the guest, but the guest has not signed in');
  assert.equal(callMember(cfg, billing, 'guest', 'get_invoice').trace[0].layer, 'upstream-sign-in');
  const linked = build((w) => w.members[1].linkedCallers.push('guest'));
  assert.deepEqual(names(listMember(linked, member(linked, 'billing'), 'guest')), ['get_invoice']);
  assert.equal(callMember(linked, member(linked, 'billing'), 'guest', 'get_invoice').ok, true);
});

test('row MCP Catalog (entitlement part): a tool the caller is not entitled to is removed from tools/list AND refused by name', T, () => {
  const cfg = build();
  for (const [caller, hidden] of [['analyst', 'crm__update_customer'], ['analyst', 'bill__refund_payment'], ['guest', 'crm__find_customer'], ['guest', 'bill__get_invoice']]) {
    assert.ok(!names(listAggregate(cfg, caller)).includes(hidden), `${caller} must not see ${hidden}`);
    const r = callAggregate(cfg, caller, hidden);
    assert.equal(r.ok, false, `${caller} must be refused ${hidden}`);
    assert.equal(r.message, REFUSAL);
  }
  // negative control: the entitled caller sees it and can call it
  assert.ok(names(listAggregate(cfg, 'operator')).includes('crm__update_customer'));
  assert.equal(callAggregate(cfg, 'operator', 'crm__update_customer').ok, true);
  // real count: how many of the 8 tools in the catalog each caller is stopped from
  const total = cfg.members.reduce((n, m) => n + m.tools.length, 0);
  assert.equal(total, 8);
  assert.deepEqual(['analyst', 'operator', 'guest'].map((c) => total - listAggregate(cfg, c).tools.length), [4, 2, 7]);
});

test('row MCP Catalog (entitlement part): an unknown entry is refused, with the same words as a hidden one', T, () => {
  const cfg = build();
  const unknown = callAggregate(cfg, 'operator', 'crm__no_such_tool');
  const hidden = callAggregate(cfg, 'operator', 'crm__export_all');
  const noMember = callAggregate(cfg, 'operator', 'nobody__find_customer');
  const noAlias = callAggregate(cfg, 'operator', 'find_customer');
  for (const r of [unknown, hidden, noMember, noAlias]) { assert.equal(r.ok, false); assert.equal(r.message, REFUSAL); assert.equal(r.error, 'tool_not_available'); }
  assert.equal(unknown.trace[0].layer, 'unknown');
  assert.equal(callMember(cfg, member(cfg, 'crm'), 'operator', 'no_such_tool').ok, false);
  assert.equal(callAggregate(cfg, 'operator', 'crm__find_customer').ok, true, 'negative control: a known entitled entry passes');
});

test('row MCP Catalog (entitlement part): the very first request is already filtered (no warm-up, no state)', T, () => {
  const first = listAggregate(build(), 'guest');
  assert.deepEqual(names(first), ['wiki__search_pages']);
  assert.deepEqual(names(listAggregate(build(), 'guest')), names(first));
});

test('default deny: a caller with no policy and no cap entry gets nothing', T, () => {
  const cfg = build((w) => { w.callers.push({ id: 'newcomer', label: 'Newcomer' }); });
  assert.deepEqual(listAggregate(cfg, 'newcomer').tools, []);
  assert.deepEqual(listAggregate(build(), 'nobody').tools, [], 'a caller id the config does not list sees nothing');
  assert.equal(callAggregate(cfg, 'newcomer', 'wiki__search_pages').ok, false);
  const ids = new Set(audit(cfg, 'newcomer').map((r) => r.layer));
  assert.ok(!ids.has(null));
});

test('the audit view names every tool and the first layer that stopped it (demo only)', T, () => {
  const cfg = build();
  const rows = audit(cfg, 'operator');
  assert.equal(rows.length, 8);
  assert.equal(rows.filter((r) => r.visible).length, 6);
  assert.deepEqual(rows.filter((r) => !r.visible).map((r) => [r.name, r.layer]), [['crm__export_all', 'aggregate-cap'], ['wiki__edit_page', 'tool-filter']]);
  for (const r of rows) assert.ok(r.layer === null || LAYERS.includes(r.layer));
  assert.equal(audit(cfg, 'operator', member(cfg, 'crm')).filter((r) => r.visible).length, 3, 'direct view: the member policy only');
  // the audit and the listing never disagree
  for (const caller of ['analyst', 'operator', 'guest']) assert.deepEqual(audit(cfg, caller).filter((r) => r.visible).map((r) => r.name), names(listAggregate(cfg, caller)));
});

// Every editable policy field must change an outcome. A field the engine ignored would leave these tests green.
const FIELD_CASES = [
  ['members[].reachable', (w) => { w.members[2].reachable = false; }, 'operator', (l) => !names(l).includes('wiki__search_pages') && l.members[2].status === 'unreachable'],
  ['members[].alias', (w) => { w.members[2].alias = 'kb'; for (const g of w.cap) g.tools = g.tools.map((t) => t.replace('wiki__', 'kb__')); }, 'operator', (l) => names(l).includes('kb__search_pages') && !names(l).includes('wiki__search_pages')],
  ['members[].upstream', (w) => { w.members[2].upstream = 'per-user'; }, 'operator', (l) => l.members[2].status === 'needs-upstream-sign-in' && !names(l).includes('wiki__search_pages')],
  ['members[].linkedCallers', (w) => { w.members[1].linkedCallers = ['analyst']; }, 'operator', (l) => l.members[1].status === 'needs-upstream-sign-in'],
  ['members[].toolFilter', (w) => { w.members[0].toolFilter = ['find_customer']; }, 'operator', (l) => !names(l).includes('crm__update_customer') && names(l).includes('crm__find_customer')],
  ['members[].policy', (w) => { grant(w.members[1].policy, 'operator').tools = ['get_invoice']; }, 'operator', (l) => !names(l).includes('bill__refund_payment') && names(l).includes('bill__get_invoice')],
  ['cap', (w) => { grant(w.cap, 'operator').tools = grant(w.cap, 'operator').tools.filter((t) => t !== 'bill__list_payments'); }, 'operator', (l) => !names(l).includes('bill__list_payments') && names(l).includes('bill__get_invoice')],
];
for (const [field, edit, caller, expect] of FIELD_CASES) {
  test(`editable field ${field}: changing it changes what the caller sees, and the unedited config does not`, T, () => {
    assert.equal(expect(listAggregate(build(), caller)), false, 'the expectation does not already hold on the default');
    assert.equal(expect(listAggregate(build(edit), caller)), true);
  });
}

test('hostile names: __proto__, constructor and friends are ordinary tool names, never object keys', T, () => {
  const evil = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const cfg = build((w) => {
    w.members[2].tools.push(...evil.map((name) => ({ name, description: 'x' })));
    w.members[2].toolFilter.push(...evil);
    grant(w.members[2].policy, 'operator').tools.push(...evil.slice(0, 2));
    grant(w.cap, 'operator').tools.push(...evil.slice(0, 2).map((n) => `wiki__${n}`));
  });
  const seen = names(listAggregate(cfg, 'operator'));
  assert.ok(seen.includes('wiki____proto__') && seen.includes('wiki__constructor'));
  assert.ok(!seen.includes('wiki__toString') && !seen.includes('wiki__hasOwnProperty'), 'only the granted ones appear');
  assert.equal(callAggregate(cfg, 'operator', 'wiki__constructor').ok, true);
  assert.equal(callAggregate(cfg, 'operator', 'wiki__toString').ok, false);
  assert.equal(callAggregate(cfg, 'analyst', 'wiki__constructor').ok, false);
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});
