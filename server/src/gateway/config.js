// Validation of a gateway config coming from the browser. Strict on purpose: unknown fields, wrong types, too many
// items, duplicate or dangling names are all refused. The error names a fixed path such as "members[1].tools" and never
// repeats a value or a key the sender typed, so a pasted token cannot come back in a message.
// No object is ever indexed by a sender-chosen key: names go into Maps and Sets, and callers appear as array items.
import { SCHEMA } from './fixture.js';

export const BOUNDS = { callers: 8, members: 6, tools: 40, listed: 400, text: 300, schemaDepth: 8, schemaNodes: 400, schemaText: 1000, schemaKey: 100 };
const ID = /^[a-z][a-z0-9-]{0,23}$/;
const ALIAS = /^[a-z][a-z0-9-]{0,15}$/; // no underscore, so alias__tool splits at the first double underscore
export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const QUALIFIED = /^[a-z][a-z0-9-]{0,15}__[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

// This lab takes no credential. Text that looks like one is refused (never echoed, never stored). This is a best-effort
// DENYLIST of shapes, not a proof: a secret in a shape it does not know passes. The safe habit is to type no secret at all.
// The text is first normalised (NFKC, so full-width letters become plain ones) and stripped of invisible format characters
// (zero-width joiners and the like), so neither can hide a shape. A letter or digit in front of a prefix disables the
// prefix rules (so "task-..." is not a key), but an underscore or a symbol does not (so "tok_ghp_..." is one).
// One rule per line: each has a name, and the tests pin each rule alone.
const CREDENTIAL = [
  ['jwt', /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/],
  ['bearer', /(?<![A-Za-z0-9])Bearer[\s_]+\S{8,}/i],
  ['key-prefix', /(?<![A-Za-z0-9])(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/],
  ['akia', /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/],
  ['mixed-token', /(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}/],
  ['hex', /[0-9a-f]{32,}/],
  ['basic', /(?<![A-Za-z0-9])[Bb]asic[\s_]+(?:(?=[A-Za-z0-9+/]*(?:[0-9+/]|[a-z][A-Z]))[A-Za-z0-9+/]{12,}={0,2}|[A-Za-z0-9+/]{12,}={1,2})/],
  ['assignment', /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api[-_]?key)\s*=\s*["']?[^\s"']{4,}/i],
];
const clean = (s) => s.normalize('NFKC').replace(/\p{Cf}/gu, '');
// The names of the rules that fire on <s> (empty for anything that is not text). For tests; credentialLike is the gate.
export const credentialRules = (s) => (typeof s === 'string' ? CREDENTIAL.filter(([, re]) => re.test(clean(s))).map(([name]) => name) : []);
export const credentialLike = (s) => credentialRules(s).length > 0;
export const RULE_NAMES = CREDENTIAL.map(([name]) => name);

export class ConfigError extends Error {
  constructor(where, what) { super(`${where}: ${what}`); this.code = 'bad_config'; }
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (o, allowed, where) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ConfigError(where, 'unexpected field');
};
const text = (v, where, max = BOUNDS.text) => {
  if (typeof v !== 'string' || v.length > max) throw new ConfigError(where, `must be text up to ${max} characters`);
  if (credentialLike(v)) throw new ConfigError(where, 'looks like a credential; this lab takes none');
  return v;
};
export const nameOk = (n, re) => typeof n === 'string' && re.test(n) && !credentialLike(n);
// A tool inputSchema is typed by the sender and comes back in list, audit and scan, so it gets the same credential check as
// every other field: every string value and every key, at any depth. The walk is bounded (depth, count, length) so a
// hostile schema is refused cleanly. It only reads own enumerable keys and never indexes an object by a typed key.
function schemaText(root, where) {
  let nodes = 0;
  const walk = (v, depth) => {
    nodes += 1;
    if (nodes > BOUNDS.schemaNodes || depth > BOUNDS.schemaDepth) throw new ConfigError(where, 'is too large or too deep');
    if (typeof v === 'string') {
      if (v.length > BOUNDS.schemaText) throw new ConfigError(where, 'has text that is too long');
      if (credentialLike(v)) throw new ConfigError(where, 'looks like a credential; this lab takes none');
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k.length > BOUNDS.schemaKey) throw new ConfigError(where, 'has a name that is too long');
        if (credentialLike(k)) throw new ConfigError(where, 'looks like a credential; this lab takes none');
        walk(x, depth + 1);
      }
    }
  };
  walk(root, 0);
}
const list = (v, where, max) => {
  if (!Array.isArray(v) || v.length > max) throw new ConfigError(where, `must be a list of at most ${max}`);
  return v;
};
const names = (v, where, re, max = BOUNDS.listed) => {
  const out = new Set();
  for (const n of list(v, where, max)) {
    if (!nameOk(n, re)) throw new ConfigError(where, 'has a name that is not allowed');
    if (out.has(n)) throw new ConfigError(where, 'has a duplicate');
    out.add(n);
  }
  return out;
};
// [{caller, tools}] -> Map(callerId -> Set(tool)). Each caller at most once; the caller must exist.
function grants(v, where, callerIds, re) {
  const out = new Map();
  for (const [i, g] of list(v, where, BOUNDS.callers).entries()) {
    const at = `${where}[${i}]`;
    if (!isObj(g)) throw new ConfigError(at, 'must be an object');
    only(g, ['caller', 'tools'], at);
    if (typeof g.caller !== 'string' || !callerIds.has(g.caller)) throw new ConfigError(at, 'caller is not a listed caller');
    if (out.has(g.caller)) throw new ConfigError(at, 'caller appears twice');
    out.set(g.caller, names(g.tools, `${at}.tools`, re));
  }
  return out;
}

// Returns a normalized, frozen-shape config of Maps and Sets. Throws ConfigError. `wire` is the matching JSON form.
export function normalizeConfig(raw) {
  if (!isObj(raw)) throw new ConfigError('config', 'must be an object');
  only(raw, ['schema', 'callers', 'members', 'cap'], 'config');
  if (raw.schema !== SCHEMA) throw new ConfigError('config.schema', 'is not a known schema');

  const callers = [];
  const callerIds = new Set();
  for (const [i, c] of list(raw.callers, 'callers', BOUNDS.callers).entries()) {
    const at = `callers[${i}]`;
    if (!isObj(c)) throw new ConfigError(at, 'must be an object');
    only(c, ['id', 'label'], at);
    if (!nameOk(c.id, ID)) throw new ConfigError(`${at}.id`, 'is not allowed');
    if (callerIds.has(c.id)) throw new ConfigError(`${at}.id`, 'is a duplicate');
    callerIds.add(c.id);
    callers.push({ id: c.id, label: text(c.label, `${at}.label`, 40) });
  }
  if (!callers.length) throw new ConfigError('callers', 'needs at least one caller');

  const members = [];
  const memberIds = new Set();
  const aliases = new Set();
  const qualifiedAll = new Set();
  for (const [i, m] of list(raw.members, 'members', BOUNDS.members).entries()) {
    const at = `members[${i}]`;
    if (!isObj(m)) throw new ConfigError(at, 'must be an object');
    only(m, ['id', 'alias', 'reachable', 'upstream', 'linkedCallers', 'toolFilter', 'tools', 'policy'], at);
    if (!nameOk(m.id, ID) || memberIds.has(m.id)) throw new ConfigError(`${at}.id`, 'is not allowed or is a duplicate');
    if (!nameOk(m.alias, ALIAS) || aliases.has(m.alias)) throw new ConfigError(`${at}.alias`, 'is not allowed or is a duplicate');
    if (typeof m.reachable !== 'boolean') throw new ConfigError(`${at}.reachable`, 'must be true or false');
    if (m.upstream !== 'none' && m.upstream !== 'per-user') throw new ConfigError(`${at}.upstream`, 'must be none or per-user');
    memberIds.add(m.id); aliases.add(m.alias);

    const tools = [];
    const toolNames = new Set();
    for (const [j, t] of list(m.tools, `${at}.tools`, BOUNDS.tools).entries()) {
      const tt = `${at}.tools[${j}]`;
      if (!isObj(t)) throw new ConfigError(tt, 'must be an object');
      only(t, ['name', 'description', 'inputSchema'], tt);
      if (!nameOk(t.name, TOOL_NAME) || toolNames.has(t.name)) throw new ConfigError(`${tt}.name`, 'is not allowed or is a duplicate');
      toolNames.add(t.name);
      if (t.inputSchema !== undefined && !isObj(t.inputSchema)) throw new ConfigError(`${tt}.inputSchema`, 'must be an object');
      if (t.inputSchema !== undefined) schemaText(t.inputSchema, `${tt}.inputSchema`);
      if (t.inputSchema !== undefined && JSON.stringify(t.inputSchema).length > 4000) throw new ConfigError(`${tt}.inputSchema`, 'is too large');
      tools.push({ name: t.name, description: text(t.description ?? '', `${tt}.description`, 1000), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } });
      qualifiedAll.add(`${m.alias}__${t.name}`);
    }
    const inTools = (set, where) => { for (const n of set) if (!toolNames.has(n)) throw new ConfigError(where, 'names a tool the member does not have'); return set; };
    const linked = names(m.linkedCallers ?? [], `${at}.linkedCallers`, ID, BOUNDS.callers);
    for (const c of linked) if (!callerIds.has(c)) throw new ConfigError(`${at}.linkedCallers`, 'names a caller that is not listed');
    const policy = grants(m.policy ?? [], `${at}.policy`, callerIds, TOOL_NAME);
    for (const [, set] of policy) inTools(set, `${at}.policy`);
    members.push({
      id: m.id, alias: m.alias, reachable: m.reachable, upstream: m.upstream, linked, tools,
      toolFilter: inTools(names(m.toolFilter ?? [], `${at}.toolFilter`, TOOL_NAME), `${at}.toolFilter`), policy,
    });
  }
  if (!members.length) throw new ConfigError('members', 'needs at least one member');

  const cap = grants(raw.cap ?? [], 'cap', callerIds, QUALIFIED);
  for (const [, set] of cap) for (const q of set) if (!qualifiedAll.has(q)) throw new ConfigError('cap', 'names a tool no member has');
  return { callers, members, cap };
}

// The JSON form of a normalized config (for tests and for echoing a default). Order follows the config.
export function toWire(cfg) {
  const g = (map) => [...map].map(([caller, set]) => ({ caller, tools: [...set] }));
  return {
    schema: SCHEMA,
    callers: cfg.callers.map((c) => ({ ...c })),
    members: cfg.members.map((m) => ({
      id: m.id, alias: m.alias, reachable: m.reachable, upstream: m.upstream, linkedCallers: [...m.linked], toolFilter: [...m.toolFilter],
      tools: m.tools.map((t) => ({ ...t })), policy: g(m.policy),
    })),
    cap: g(cfg.cap),
  };
}
