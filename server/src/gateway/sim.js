// A simulated MCP gateway: entitlement-aware discovery and an aggregate of member MCP servers whose policy is a cap.
//
// WHAT THIS IS. A lab-invented model of what Ping's deck says the 2026-11-02 release does (slides 36 and 37). It is a
// Ping release claim. Real mode measured the listing and the cap on SE gateway v1.261106 (2026-11-08); access by
// caller was measured per aggregate (2026-11-09); per-tool filtering per caller is still UNVERIFIED on our tenant. Nothing in THIS file calls a gateway, a tenant or the network. It is pure functions over a normalized config (config.js).
//
// THE MODEL (each rule is a claim; see provenance.js for how each name is tagged):
//  1. Discovery is entitlement-aware: a tool the caller is not entitled to is REMOVED from tools/list, not just refused.
//  2. The same tool called by name is refused again (hiding by omission is not security).
//  3. An aggregate namespaces each member's tools as <alias>__<tool>. The aggregate's policy (the "cap") limits what any
//     member tool may be used by a caller. The cap is enforced on the listing AND again at the member hop. A cap only
//     removes: a tool the member denies stays hidden even if the cap would allow it.
//  4. An unreachable member is reported, not silently dropped. A member that needs the caller's own upstream sign-in is
//     reported as needing it, and offers that caller nothing until then.
//  5. The same tool reached through the member directly follows the member's own policy only (no cap, no filter).
//
// Layers a tool can be stopped at, in the order they are checked: unreachable, upstream-sign-in, tool-filter,
// member-policy, aggregate-cap. Default is deny: a caller with no entry in a policy or cap gets nothing.

export const LAYERS = ['unreachable', 'upstream-sign-in', 'tool-filter', 'member-policy', 'aggregate-cap'];
export const REFUSAL = 'That tool is not available to this caller.';
const NOT_AVAILABLE = Object.freeze({ error: 'tool_not_available', message: REFUSAL });

const q = (m, tool) => `${m.alias}__${tool}`;
const allows = (map, caller, name) => map.get(caller)?.has(name) === true;

// The first layer that stops <tool> of member <m> for <caller> when reached through the aggregate, or null.
export function aggregateLayer(cfg, m, tool, caller) {
  if (!m.reachable) return 'unreachable';
  if (m.upstream === 'per-user' && !m.linked.has(caller)) return 'upstream-sign-in';
  if (!m.toolFilter.has(tool)) return 'tool-filter';
  if (!allows(m.policy, caller, tool)) return 'member-policy';
  if (!allows(cfg.cap, caller, q(m, tool))) return 'aggregate-cap';
  return null;
}
// The first layer that stops <tool> when the member is used directly: its own policy only.
export function directLayer(m, tool, caller) {
  if (!m.reachable) return 'unreachable';
  if (m.upstream === 'per-user' && !m.linked.has(caller)) return 'upstream-sign-in';
  if (!allows(m.policy, caller, tool)) return 'member-policy';
  return null;
}

export const callerOf = (cfg, id) => cfg.callers.find((c) => c.id === id) ?? null;
export const memberOf = (cfg, id) => cfg.members.find((m) => m.id === id) ?? null;
const status = (m, caller) => (!m.reachable ? 'unreachable' : m.upstream === 'per-user' && !m.linked.has(caller) ? 'needs-upstream-sign-in' : 'ok');
const entry = (t, name) => ({ name, description: t.description, inputSchema: t.inputSchema });

// tools/list through the aggregate. Hidden tools are absent and nothing says how many there were.
export function listAggregate(cfg, caller) {
  const tools = [];
  for (const m of cfg.members) for (const t of m.tools) if (aggregateLayer(cfg, m, t.name, caller) === null) tools.push(entry(t, q(m, t.name)));
  return { tools, members: cfg.members.map((m) => ({ alias: m.alias, status: status(m, caller) })) };
}
// tools/list on one member used directly.
export function listMember(cfg, m, caller) {
  const tools = [];
  for (const t of m.tools) if (directLayer(m, t.name, caller) === null) tools.push(entry(t, t.name));
  return { tools, members: [{ alias: m.alias, status: status(m, caller) }] };
}

// The second enforcement point. It runs after routing, with the tool's own name, and re-checks the cap and the member's
// own policy. Exported so a test can drive it alone; callAggregate always runs it after the entry check.
export function stageHop(cfg, m, tool, caller) {
  if (!m.reachable) return 'unreachable';
  if (!allows(m.policy, caller, tool)) return 'member-policy';
  if (!allows(cfg.cap, caller, q(m, tool))) return 'aggregate-cap';
  return null;
}
// The first enforcement point for a call by name: the same decision the listing makes.
export function stageEntry(cfg, m, tool, caller) { return aggregateLayer(cfg, m, tool, caller); }

function split(cfg, qualified) {
  const i = qualified.indexOf('__');
  if (i < 1) return null;
  const m = cfg.members.find((x) => x.alias === qualified.slice(0, i));
  const tool = qualified.slice(i + 2);
  return m && m.tools.some((t) => t.name === tool) ? { m, tool } : null;
}
const refused = (trace) => ({ ok: false, ...NOT_AVAILABLE, trace });
const done = (what) => ({ ok: true, result: { content: [{ type: 'text', text: `simulated result for ${what} (nothing was run)` }] } });

// tools/call by qualified name. The caller always gets REFUSAL; `trace` says where it was stopped, for the demo only.
export function callAggregate(cfg, caller, qualified) {
  const hit = split(cfg, qualified);
  if (!hit) return refused([{ stage: 'entry', layer: 'unknown', decision: 'refused' }]);
  const first = stageEntry(cfg, hit.m, hit.tool, caller);
  if (first) return refused([{ stage: 'entry', layer: first, decision: 'refused' }]);
  const second = stageHop(cfg, hit.m, hit.tool, caller);
  if (second) return refused([{ stage: 'entry', layer: 'none', decision: 'passed' }, { stage: 'member-hop', layer: second, decision: 'refused' }]);
  return { ...done(qualified), trace: [{ stage: 'entry', layer: 'none', decision: 'passed' }, { stage: 'member-hop', layer: 'none', decision: 'passed' }] };
}
// tools/call on one member used directly: only the member's own policy.
export function callMember(cfg, m, caller, tool) {
  const t = m.tools.find((x) => x.name === tool);
  if (!t) return refused([{ stage: 'member', layer: 'unknown', decision: 'refused' }]);
  const layer = directLayer(m, tool, caller);
  if (layer) return refused([{ stage: 'member', layer, decision: 'refused' }]);
  return { ...done(tool), trace: [{ stage: 'member', layer: 'none', decision: 'passed' }] };
}

// Demo audit view: every tool, who is stopped where. This is NOT what a caller sees; it names hidden tools on purpose.
export function audit(cfg, caller, member = null) {
  const rows = [];
  for (const m of member ? [member] : cfg.members) {
    for (const t of m.tools) {
      const layer = member ? directLayer(m, t.name, caller) : aggregateLayer(cfg, m, t.name, caller);
      rows.push({ name: member ? t.name : q(m, t.name), member: m.alias, visible: layer === null, layer });
    }
  }
  return rows;
}
