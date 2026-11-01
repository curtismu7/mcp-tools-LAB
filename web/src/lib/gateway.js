import { useCallback, useEffect, useState } from "react";
import { get } from "./api.js";

// State of the simulated gateway (Ping release claim of 2026-11-02, UNVERIFIED on our tenant). It lives in the app shell,
// not in the page, so one Reset can restore it together with the diagram. The default config always comes from the
// server (GET /api/gateway/default); nothing here keeps a second copy of it.

export const ALIAS = /^[a-z][a-z0-9-]{0,15}$/;
export const BANNER = "Ping release claim (2026-11-02), UNVERIFIED on our tenant";
export const LAYER_TEXT = {
  unknown: "no such tool",
  unreachable: "the member server is unreachable",
  "upstream-sign-in": "the caller has not signed in to the member",
  "tool-filter": "the aggregate ToolFilter does not expose it",
  "member-policy": "the member's own policy does not allow it",
  "aggregate-cap": "the aggregate policy cap does not allow it",
};
export const STATUS_TEXT = { ok: "reachable", unreachable: "unreachable", "needs-upstream-sign-in": "needs the caller's own sign-in" };

const qualified = (m, tool) => `${m.alias}__${tool}`;
const grantOf = (list, caller) => list.find((g) => g.caller === caller)?.tools ?? [];

/** Add or remove one tool in a [{caller, tools}] list. A caller with no tools left is dropped from the list. */
export function toggleGrant(list, caller, tool, on) {
  const has = list.some((g) => g.caller === caller);
  const next = list.map((g) => (g.caller === caller ? { ...g, tools: on ? [...new Set([...g.tools, tool])] : g.tools.filter((t) => t !== tool) } : g));
  if (on && !has) next.push({ caller, tools: [tool] });
  return next.filter((g) => g.tools.length > 0);
}
export const granted = (list, caller, tool) => grantOf(list, caller).includes(tool);

export function setMember(config, id, patch) {
  return { ...config, members: config.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}
/** Rename an alias and carry the cap entries with it, so the cap keeps naming the same tools. */
export function renameAlias(config, id, alias) {
  const m = config.members.find((x) => x.id === id);
  if (!m || !ALIAS.test(alias) || config.members.some((x) => x.id !== id && x.alias === alias)) return config;
  const cap = config.cap.map((g) => ({ ...g, tools: g.tools.map((t) => (t.startsWith(`${m.alias}__`) ? `${alias}__${t.slice(m.alias.length + 2)}` : t)) }));
  return { ...setMember(config, id, { alias }), cap };
}
export const toggleToolFilter = (config, id, tool, on) => {
  const m = config.members.find((x) => x.id === id);
  return setMember(config, id, { toolFilter: on ? [...new Set([...m.toolFilter, tool])] : m.toolFilter.filter((t) => t !== tool) });
};
export const toggleLinked = (config, id, caller, on) => {
  const m = config.members.find((x) => x.id === id);
  return setMember(config, id, { linkedCallers: on ? [...new Set([...m.linkedCallers, caller])] : m.linkedCallers.filter((c) => c !== caller) });
};
export const togglePolicy = (config, id, caller, tool, on) => {
  const m = config.members.find((x) => x.id === id);
  return setMember(config, id, { policy: toggleGrant(m.policy, caller, tool, on) });
};
export const toggleCap = (config, caller, name, on) => ({ ...config, cap: toggleGrant(config.cap, caller, name, on) });
export const allQualified = (config) => config.members.flatMap((m) => m.tools.map((t) => qualified(m, t.name)));

const INITIAL = { config: null, claim: null, tags: null, provenance: null, caller: "operator", view: "aggregate", member: "crm", call: null, scan: null };

/** One instance, owned by the shell. `reset` fetches the default again and clears every result. */
export function useGateway() {
  const [state, setState] = useState(INITIAL);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    const r = await get("/api/gateway/default");
    if (r.ok) { setState({ ...INITIAL, config: r.data.config, claim: r.data.claim, tags: r.data.tags, provenance: r.data.provenance }); setError(null); }
    else setError(r.data?.message || `The simulated gateway did not load (${r.status}).`);
  }, []);
  useEffect(() => { load(); }, [load]);
  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);
  // Any change to the config makes an old call result or scan stale, so they are cleared with it.
  const edit = useCallback((next) => setState((s) => ({ ...s, config: next, call: null, scan: null })), []);
  return { state, error, patch, edit, reset: load, ready: state.config !== null };
}
