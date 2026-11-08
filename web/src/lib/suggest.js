// Values the call form fills in for a person who will not know an account id, a user id or a city (owner 2026-11-07).
// Four sources, strongest first; every filled field says where its value came from and stays editable:
//   identity  the signed-in user's token claims (sub, email, username): never the token itself;
//   demo      sample values we ship for our own servers (server/data/sample-values.json);
//   lookup    "Pick": the server's own read-only list tool, run behind the normal Review + confirm (see idLookup);
//   schema    the schema's own default, example or first enum value, with narrow limits (safeSchemaValue).
// A schema `default` used to be NEVER filled (an off-box default is the classic exfil sink); the owner asked for it,
// so it is filled only when it is plain text that cannot send data anywhere, and never on a tool the scan flagged.
const URLISH = /(^|[\s"'(<])([a-z][a-z0-9+.-]*:\/\/|www\.|\/\/)|@[^\s@]+\.[^\s@]+|(^|\s)(~|\.\.?)?\/[^\s/]|[a-z]:\\|\.(com|net|org|io|dev|invalid|example|local|internal)(\b|$)|\b\d{1,3}(\.\d{1,3}){3}\b|[<>`$]|\{\{/i;
const MAX_TEXT = 120;
const FIELD_ID = /(^|_)ids?$|Id$|^id$/;

export const sourceLabel = { identity: "signed-in user", demo: "demo value", schema: "from the server's schema", lookup: "picked from the server" };

// A schema value that is plain and cannot send anything anywhere: a short word, a number, a boolean. Never a URL,
// address, host, path, markup or template.
export function safeSchemaValue(p) {
  const candidates = [p?.default, ...(Array.isArray(p?.examples) ? p.examples.slice(0, 2) : []), ...(Array.isArray(p?.enum) ? p.enum.slice(0, 1) : [])];
  for (const v of candidates) {
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
    if (typeof v === "string" && v.trim() && v.length <= MAX_TEXT && !URLISH.test(v) && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(v)) return v;
  }
  return undefined;
}

const idKind = (name) => (/^(user_?id|userid|sub|subject|user)$/i.test(name) ? "sub" : /e-?mail/i.test(name) ? "email" : /^(user_?name|username|login)$/i.test(name) ? "username" : null);

/**
 * fields: [{name, p, required}] from the schema; fill: {demo, identity} from GET /connections/:id/fill;
 * flagged: the scan flagged this tool (then nothing from the schema is filled).
 * Returns {values: {name: string|boolean}, from: {name: source}}. Every demo or identity match is filled; schema values
 * only for REQUIRED fields and only when the tool is not flagged.
 */
export function suggestValues(fields, { fill = {}, flagged = false } = {}) {
  const values = {}; const from = {};
  const set = (name, v, src) => { if (v === undefined || v === null || v === "") return; values[name] = typeof v === "boolean" ? v : String(v); from[name] = src; };
  for (const { name, p, required } of fields || []) {
    const kind = idKind(name);
    if (kind && fill.identity?.[kind]) { set(name, fill.identity[kind], "identity"); continue; }
    if (fill.demo && Object.hasOwn(fill.demo, name)) { set(name, fill.demo[name], "demo"); continue; }
    // Only a required field is filled from the schema: an optional one is left empty so the server applies its own default.
    if (!flagged && required) { const v = safeSchemaValue(p); if (v !== undefined) set(name, v, "schema"); }
  }
  return { values, from };
}

// "Pick": which of the server's own tools lists the thing this id field names. account_id -> a tool like
// get_my_accounts / list_accounts / get_accounts / list_banking_accounts that needs no arguments.
const noArgs = (t) => !(t?.inputSchema?.required || []).length;
export function listToolFor(fieldName, tools) {
  if (!FIELD_ID.test(fieldName) || /^id$/i.test(fieldName)) return null;
  const noun = String(fieldName).replace(/(_?id|Id)s?$/, "").replace(/^(to|from|new|my)[_A-Z]/, "").replace(/_/g, "").toLowerCase();
  if (noun.length < 3) return null;
  const rx = new RegExp(`^(list_|get_my_|get_|search_|view_|query_)?([a-z]+_)?${noun}s?$|^(list_|get_my_|get_)(all_)?([a-z]+_)?${noun}s$`, "i");
  const hits = (tools || []).filter((t) => noArgs(t) && /^(list|get|view|search|query)/i.test(t.name) && rx.test(t.name.replace(/-/g, "_")));
  hits.sort((a, b) => (/^(list_|get_my_)/.test(a.name) ? 0 : 1) - (/^(list_|get_my_)/.test(b.name) ? 0 : 1) || a.name.length - b.name.length);
  return hits[0]?.name || null;
}

// The choices in a tool result: the first array of objects that carry an id, as {id, label}. The result is text from a
// server (untrusted): ids and labels are clipped and only ever shown as text and put in a field the person can edit.
export function choicesFrom(result) {
  const texts = (result?.content || []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
  const docs = [result?.structuredContent, ...texts.map((t) => { try { return JSON.parse(t); } catch { return null; } })].filter(Boolean);
  const find = (v, depth) => {
    if (depth > 4 || !v || typeof v !== "object") return null;
    if (Array.isArray(v)) { if (v.length && v.every((x) => x && typeof x === "object" && (typeof x.id === "string" || typeof x.id === "number"))) return v; for (const x of v) { const r = find(x, depth + 1); if (r) return r; } return null; }
    for (const k of Object.keys(v)) { const r = find(v[k], depth + 1); if (r) return r; }
    return null;
  };
  for (const d of docs) {
    const list = find(d, 0);
    if (list) return list.slice(0, 50).map((x) => ({ id: String(x.id).slice(0, 80), label: String(x.name || x.title || x.nickname || x.accountType || x.type || x.description || "").slice(0, 80) }));
  }
  return [];
}
