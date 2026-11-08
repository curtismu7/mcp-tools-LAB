// Real mode for the entitled-listing page: measure a real gateway's MCP aggregate apps with the operator's own agent keys.
//
// Settings (the process environment wins, then STANDALONE_ENV, then ~/Development/.env):
//   MCP_TOOLS_GW_URL          the gateway origin (https, or http on loopback). Each app is reached at <origin>/<app>/mcp.
//   MCP_TOOLS_GW_APPS         comma-separated MCP aggregate app names to compare.
//   MCP_TOOLS_GW_KEY_<NAME>   one agent access key per caller (write-only). NAME becomes the caller's label.
//
// Rules: a key is never returned, logged or echoed (every gateway message is scrubbed of all keys); this module only
// lists tools, and only calls a tool by name when that name is NOT in the caller's listing (to test the refusal). A listed
// tool is called from the Server page, behind the confirm gate. Which of the six checks a refusal matches is our reading
// of the gateway's words, and the response says so.
import fs from 'node:fs';
import { createHttpClient } from '../mcp/http.js';
import { clip, scrub, scrubJson } from '../redact.js';

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = /^[A-Z0-9][A-Z0-9_]{0,31}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_TOOLS = 400;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function readFileSettings(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^(MCP_TOOLS_GW_[A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no such file */ }
  return out;
}

export function readSettings(env = process.env) {
  const files = [env.STANDALONE_ENV, env.HOME ? `${env.HOME}/Development/.env` : null].filter(Boolean);
  const merged = {};
  for (const f of files.reverse()) Object.assign(merged, readFileSettings(f));
  for (const [k, v] of Object.entries(env)) if (k.startsWith('MCP_TOOLS_GW_') && v) merged[k] = String(v).trim();
  return merged;
}

const NOT_SET = 'Set MCP_TOOLS_GW_URL, MCP_TOOLS_GW_APPS and at least one MCP_TOOLS_GW_KEY_<NAME> in ~/Development/.env (or STANDALONE_ENV). Mock keeps working.';

/** -> { ok: true, origin, apps, callers: [{ id, label, key }] } or { ok: false, problem } */
export function realConfig(s) {
  if (!s.MCP_TOOLS_GW_URL) return { ok: false, problem: `Real is not configured: no gateway URL. ${NOT_SET}` };
  let url;
  try { url = new URL(s.MCP_TOOLS_GW_URL); } catch { return { ok: false, problem: `Real is not configured: MCP_TOOLS_GW_URL is not a URL. ${NOT_SET}` }; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return { ok: false, problem: 'Real is not configured: MCP_TOOLS_GW_URL must be https (http only on loopback).' };
  const apps = String(s.MCP_TOOLS_GW_APPS || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!apps.length || apps.some((a) => !APP.test(a))) return { ok: false, problem: `Real is not configured: MCP_TOOLS_GW_APPS must list app names (lowercase letters, digits, dashes), comma-separated. ${NOT_SET}` };
  const callers = Object.entries(s).filter(([k]) => k.startsWith('MCP_TOOLS_GW_KEY_')).map(([k, key]) => ({ id: k.slice('MCP_TOOLS_GW_KEY_'.length), key }))
    .filter((c) => NAME.test(c.id) && c.key && !/[\s\u0000-\u001f]/.test(c.key))
    .map((c) => ({ ...c, id: c.id.toLowerCase(), label: c.id.charAt(0) + c.id.slice(1).toLowerCase().replace(/_/g, ' ') }));
  if (!callers.length) return { ok: false, problem: `Real is not configured: no agent key. ${NOT_SET}` };
  return { ok: true, origin: url.origin, apps, callers };
}

// Which of the six checks a gateway refusal looks like. Our reading of the gateway's words, not a field it sends.
export function readRefusal(err) {
  const msg = String(err?.message || '');
  if (err?.httpStatus === 401) return 'key';
  if (/not exposed by this aggregate/i.test(msg)) return 'tool-filter';
  if (/refused by policy|blocked by policy|not allowed|forbidden/i.test(msg) || err?.httpStatus === 403) return 'policy';
  if (/failed to connect|unreachable|connection refused|timed out/i.test(msg)) return 'unreachable';
  if (/unknown tool|tool not found|no such tool/i.test(msg)) return 'unknown';
  return 'other';
}

export function createReal({ env = process.env, client = createHttpClient } = {}) {
  const load = () => realConfig(readSettings(env));
  const secrets = (cfg) => (cfg.ok ? cfg.callers.map((c) => c.key) : []);
  const refusal = (cfg, err) => ({ status: err?.httpStatus ?? null, message: clip(scrub(err?.message || 'the gateway refused', secrets(cfg))), layer: readRefusal(err) });

  function open(cfg, app, caller) {
    const c = cfg.callers.find((x) => x.id === caller);
    return client({ url: `${cfg.origin}/${app}/mcp`, getAuth: () => ['Authorization', `Bearer ${c.key}`], clientInfo: { name: 'mcp-tools-lab', version: '0.1.0' } });
  }
  async function list(cfg, app, caller) {
    const mcp = open(cfg, app, caller);
    const started = Date.now();
    try {
      const r = await mcp.rpc('tools/list', {});
      const tools = (Array.isArray(r?.tools) ? r.tools : []).slice(0, MAX_TOOLS).map((t) => ({ name: clip(t?.name, 160), description: clip(t?.description, 300) }));
      return { ok: true, tools: scrubJson(tools, secrets(cfg)), ms: Date.now() - started };
    } catch (err) {
      return { ok: false, refusal: refusal(cfg, err), ms: Date.now() - started };
    } finally { await mcp.close().catch(() => {}); }
  }
  async function callHidden(cfg, app, caller, tool) {
    const mcp = open(cfg, app, caller);
    const started = Date.now();
    try {
      const r = await mcp.rpc('tools/call', { name: tool, arguments: {} });
      const text = Array.isArray(r?.content) ? r.content.map((x) => (x?.type === 'text' ? x.text : `[${x?.type}]`)).join('\n') : '';
      return { ok: true, isError: r?.isError === true, text: clip(scrub(text, secrets(cfg)), 600), ms: Date.now() - started };
    } catch (err) {
      return { ok: false, refusal: refusal(cfg, err), ms: Date.now() - started };
    } finally { await mcp.close().catch(() => {}); }
  }
  return { load, list, callHidden, isApp: (cfg, a) => cfg.apps.includes(a), isCaller: (cfg, id) => cfg.callers.some((c) => c.id === id), isTool: (t) => typeof t === 'string' && TOOL.test(t) };
}
