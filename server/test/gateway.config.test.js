// The config validator, one rule at a time. Every refusal test changes ONE thing in an otherwise valid config (so a refusal
// cannot be a side effect such as a dangling name), names the path in the message, and sits beside a control that is
// accepted. Bounds are written as literal numbers here, not read from BOUNDS, so a changed bound is noticed.
// Ping release claim of 2026-11-02 (listing and cap measured on gateway v1.261106; access by caller measured per aggregate (2026-11-09), per-tool filtering per caller UNVERIFIED on our tenant).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, normalizeConfig } from '../src/gateway/config.js';
import { freshConfig } from '../src/gateway/fixture.js';

const T = { timeout: 60_000 };
const n = (len) => 'n'.repeat(len); // 'n' is no hex digit, so no run of it looks like a credential
const caller = (id) => ({ id, label: 'Extra' });
const member = (over = {}) => ({ id: 'extra', alias: 'extra', reachable: true, upstream: 'none', linkedCallers: [], toolFilter: [], tools: [], policy: [], ...over });
const accepted = (edit) => { const c = freshConfig(); edit(c); return normalizeConfig(c); };
function refused(edit, where, what, why = where) {
  const c = freshConfig(); edit(c);
  assert.throws(() => normalizeConfig(c), (e) => e instanceof ConfigError && e.code === 'bad_config' && e.message.startsWith(`${where}: `) && e.message.includes(what), `${why}: expected "${where}: ...${what}..."`);
}
// member 0 (crm) with <count> tools, nothing else naming them, so only the count can be wrong
function withTools(c, count, nameOf = (i) => `t${i}`) {
  c.members[0].tools = Array.from({ length: count }, (_, i) => ({ name: nameOf(i), description: 'x' }));
  c.members[0].toolFilter = []; c.members[0].policy = [];
  c.cap = c.cap.map((g) => ({ ...g, tools: g.tools.filter((t) => !t.startsWith('crm__')) }));
}

test('control: the default config and each edited config below are valid until the one change is made', T, () => {
  const cfg = normalizeConfig(freshConfig());
  assert.equal(cfg.callers.length, 3);
  assert.equal(cfg.members.length, 3);
  accepted((c) => { c.members[0].tools.push({ name: 'another_tool', description: 'x' }); });
  accepted((c) => { c.callers.push(caller('fourth')); });
});

test('a duplicate is refused when it is the ONLY thing wrong: tool name, caller id, member id, alias', T, () => {
  refused((c) => { c.members[0].tools.push({ name: 'find_customer', description: 'again' }); }, 'members[0].tools[3].name', 'duplicate', 'duplicate tool name');
  refused((c) => { c.callers.push(caller('analyst')); }, 'callers[3].id', 'duplicate', 'duplicate caller id');
  refused((c) => { c.members.push(member({ id: 'crm', alias: 'other' })); }, 'members[3].id', 'duplicate', 'duplicate member id');
  refused((c) => { c.members.push(member({ alias: 'crm' })); }, 'members[3].alias', 'duplicate', 'duplicate alias');
  // controls: the same extra rows with fresh names are accepted
  accepted((c) => { c.members[0].tools.push({ name: 'find_other', description: 'x' }); });
  accepted((c) => { c.members.push(member({ id: 'crm2', alias: 'other' })); });
});

test('a duplicate inside a name list is refused when it is the ONLY thing wrong: toolFilter, policy, linkedCallers, cap', T, () => {
  refused((c) => { c.members[0].toolFilter.push('find_customer'); }, 'members[0].toolFilter', 'duplicate', 'toolFilter');
  refused((c) => { c.members[0].policy[0].tools.push('find_customer'); }, 'members[0].policy[0].tools', 'duplicate', 'policy');
  refused((c) => { c.members[1].linkedCallers.push('analyst'); }, 'members[1].linkedCallers', 'duplicate', 'linkedCallers');
  refused((c) => { c.cap[0].tools.push('crm__find_customer'); }, 'cap[0].tools', 'duplicate', 'cap');
  // controls: a new, different name in each list is accepted
  accepted((c) => { c.members[0].policy[0].tools.push('update_customer'); });
  accepted((c) => { c.members[1].linkedCallers.push('guest'); });
  accepted((c) => { c.cap[0].tools.push('crm__update_customer'); });
});

test('an alias with an underscore is refused (it would break the alias__tool split) when it is the ONLY thing wrong', T, () => {
  for (const alias of ['x_y', 'a_', 'x__y', '_x', 'x_']) refused((c) => { c.members.push(member({ alias })); }, 'members[3].alias', 'not allowed', `alias ${alias}`);
  // the cap cannot name such an alias either
  refused((c) => { c.cap[0].tools.push('x_y__find_customer'); }, 'cap[0].tools', 'not allowed', 'cap name with an underscore alias');
  // controls: a hyphen is fine, and the split is at the first double underscore
  const cfg = accepted((c) => { c.members.push(member({ alias: 'x-y' })); });
  assert.equal(cfg.members[3].alias, 'x-y');
  // the same rows with an uppercase letter or a leading digit are refused too (the pattern is the whole rule)
  for (const alias of ['Xy', '1xy', 'x.y', 'x y']) refused((c) => { c.members.push(member({ alias })); }, 'members[3].alias', 'not allowed', `alias ${alias}`);
});

test('zero callers and zero members are refused; one of each is accepted', T, () => {
  refused((c) => { c.callers = []; c.members.forEach((m) => { m.linkedCallers = []; m.policy = []; }); c.cap = []; }, 'callers', 'at least one');
  refused((c) => { c.members = []; c.cap = []; }, 'members', 'at least one');
  accepted((c) => { c.callers = [c.callers[0]]; c.members.forEach((m) => { m.linkedCallers = m.linkedCallers.filter((x) => x === 'analyst'); m.policy = m.policy.filter((g) => g.caller === 'analyst'); }); c.cap = c.cap.filter((g) => g.caller === 'analyst'); });
  accepted((c) => { c.members = [c.members[2]]; c.cap = c.cap.map((g) => ({ ...g, tools: g.tools.filter((t) => t.startsWith('wiki__')) })); });
});

test('an unknown field is refused at every level: config, caller, member, tool, grant', T, () => {
  refused((c) => { c.extra = 1; }, 'config', 'unexpected field', 'config');
  refused((c) => { c.callers[0].role = 'admin'; }, 'callers[0]', 'unexpected field', 'caller');
  refused((c) => { c.members[0].color = 'red'; }, 'members[0]', 'unexpected field', 'member');
  refused((c) => { c.members[0].tools[0].title = 'x'; }, 'members[0].tools[0]', 'unexpected field', 'tool');
  refused((c) => { c.members[0].policy[0].note = 'x'; }, 'members[0].policy[0]', 'unexpected field', 'policy grant');
  refused((c) => { c.cap[0].note = 'x'; }, 'cap[0]', 'unexpected field', 'cap grant');
  refused((c) => { c.schema = 'gateway-claim/2'; }, 'config.schema', 'not a known schema', 'schema');
  // the message names the place, never the unknown key the sender typed
  const c = freshConfig(); c.zzUnknownKeyzz = 1;
  assert.throws(() => normalizeConfig(c), (e) => !e.message.includes('zzUnknownKeyzz'));
});

test('count limits, with literal values: callers 8, members 6, tools per member 40, names in a list 400, grants 8', T, () => {
  const moreCallers = (c, count) => { for (let i = 0; i < count; i += 1) c.callers.push(caller(`c${i}`)); };
  accepted((c) => moreCallers(c, 5)); // 3 + 5 = 8
  refused((c) => moreCallers(c, 6), 'callers', 'at most 8'); // 9
  const moreMembers = (c, count) => { for (let i = 0; i < count; i += 1) c.members.push(member({ id: `m${i}`, alias: `m${i}` })); };
  accepted((c) => moreMembers(c, 3)); // 3 + 3 = 6
  refused((c) => moreMembers(c, 4), 'members', 'at most 6'); // 7
  accepted((c) => withTools(c, 40));
  refused((c) => withTools(c, 41), 'members[0].tools', 'at most 40');
  // 401 names is refused for its length; 400 names pass the length check and fail later (they are not tools of the member)
  refused((c) => { c.members[0].toolFilter = Array.from({ length: 401 }, (_, i) => `t${i}`); }, 'members[0].toolFilter', 'at most 400');
  assert.throws(() => { const c = freshConfig(); c.members[0].toolFilter = Array.from({ length: 400 }, (_, i) => `t${i}`); normalizeConfig(c); }, (e) => !/at most/.test(e.message));
  // linkedCallers and the grants lists are limited by the number of callers (8)
  accepted((c) => { moreCallers(c, 5); c.members[1].linkedCallers = c.callers.map((x) => x.id); }); // 8 callers, 8 linked
  refused((c) => { moreCallers(c, 5); c.members[1].linkedCallers = [...c.callers.map((x) => x.id), 'ninth']; }, 'members[1].linkedCallers', 'at most 8');
  accepted((c) => { moreCallers(c, 5); c.cap = c.callers.map((x) => ({ caller: x.id, tools: [] })); });
  refused((c) => { moreCallers(c, 5); c.cap = [...c.callers.map((x) => ({ caller: x.id, tools: [] })), { caller: 'analyst', tools: [] }]; }, 'cap', 'at most 8');
});

test('length limits, with literal values: label 40, description 1000, caller id 24, member id 24, alias 16, tool name 64', T, () => {
  accepted((c) => { c.callers[0].label = n(40); });
  refused((c) => { c.callers[0].label = n(41); }, 'callers[0].label', 'up to 40');
  accepted((c) => { c.members[0].tools[0].description = n(1000); });
  refused((c) => { c.members[0].tools[0].description = n(1001); }, 'members[0].tools[0].description', 'up to 1000');
  accepted((c) => { c.callers.push(caller(n(24))); });
  refused((c) => { c.callers.push(caller(n(25))); }, 'callers[3].id', 'not allowed');
  accepted((c) => { c.members.push(member({ id: n(24) })); });
  refused((c) => { c.members.push(member({ id: n(25) })); }, 'members[3].id', 'not allowed');
  accepted((c) => { c.members.push(member({ alias: n(16) })); });
  refused((c) => { c.members.push(member({ alias: n(17) })); }, 'members[3].alias', 'not allowed');
  accepted((c) => withTools(c, 1, () => n(64)));
  refused((c) => withTools(c, 1, () => n(65)), 'members[0].tools[0].name', 'not allowed');
  // a tool name may not start with a digit or hold a space, and a caller id may not hold an underscore
  refused((c) => withTools(c, 1, () => '1abc'), 'members[0].tools[0].name', 'not allowed');
  refused((c) => withTools(c, 1, () => 'a b'), 'members[0].tools[0].name', 'not allowed');
  refused((c) => { c.callers.push(caller('a_b')); }, 'callers[3].id', 'not allowed');
});

// An inputSchema whose JSON text is exactly <size> characters, built from several short strings (each under the string limit).
function schemaOfSize(size) {
  const props = {};
  for (let i = 0; i < 5; i += 1) props[`p${i}`] = { type: 'string', description: '' };
  let left = size - JSON.stringify({ type: 'object', properties: props }).length;
  for (const k of Object.keys(props)) { const take = Math.min(900, left); props[k].description = n(take); left -= take; }
  const schema = { type: 'object', properties: props };
  assert.equal(left, 0);
  assert.equal(JSON.stringify(schema).length, size);
  return schema;
}
const nest = (depth) => { let o = 'leaf'; for (let i = 0; i < depth; i += 1) o = { k: o }; return o; };
const withSchema = (inputSchema) => (c) => { c.members[0].tools[0].inputSchema = inputSchema; };

test('inputSchema limits, with literal values: 4000 characters of JSON, 1000 per string, 100 per key, 400 values, depth 8', T, () => {
  accepted(withSchema(schemaOfSize(4000)));
  refused(withSchema(schemaOfSize(4001)), 'members[0].tools[0].inputSchema', 'too large');
  accepted(withSchema({ type: 'object', x: n(1000) }));
  refused(withSchema({ type: 'object', x: n(1001) }), 'members[0].tools[0].inputSchema', 'too long');
  accepted(withSchema({ type: 'object', [n(100)]: 1 }));
  refused(withSchema({ type: 'object', [n(101)]: 1 }), 'members[0].tools[0].inputSchema', 'too long');
  // values: the root, "object", the list and its items all count
  accepted(withSchema({ type: 'object', x: Array.from({ length: 397 }, () => 1) }));
  refused(withSchema({ type: 'object', x: Array.from({ length: 398 }, () => 1) }), 'members[0].tools[0].inputSchema', 'too large or too deep');
  accepted(withSchema({ type: 'object', x: nest(7) }));
  refused(withSchema({ type: 'object', x: nest(8) }), 'members[0].tools[0].inputSchema', 'too large or too deep');
  // a hostile depth is refused cleanly (no stack overflow)
  refused(withSchema({ type: 'object', x: nest(5000) }), 'members[0].tools[0].inputSchema', 'too large or too deep');
});
