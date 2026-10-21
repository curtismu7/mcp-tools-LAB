// Saved connections. Adapted from AI-DEMO2 standalone/mcp-inspector server/lib/profileStore.js (MIT), changed to:
//  - ESM, instance per data dir, atomic write, file mode 600 in a mode 700 directory;
//  - secrets (token, stdio env values) are held here and never returned: publicView() shows 'set' only;
//  - stdio connections live in memory for this session only (a command is launched only from a request the operator
//    typed this session, never from a file or a server response), so they are never written to disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TRANSPORTS = new Set(['http', 'stdio', 'pingone']);

// A URL with credentials or a non-http scheme is refused; query values are masked in anything shown.
function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must be http or https');
  if (u.username || u.password) throw new Error('put credentials in the token field, not in the URL');
  return u.toString();
}

export function createStore({ dir }) {
  const file = path.join(dir, 'connections.json');
  const session = new Map(); // stdio connections (never persisted)

  function loadDisk() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const out = {};
      // Only http entries are honoured from disk; a stdio entry planted in the file is ignored.
      for (const [id, rec] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) if (rec?.transport === 'http' || rec?.transport === 'pingone') out[id] = rec;
      return out;
    } catch { return {}; }
  }
  function saveDisk(all) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  function publicView(rec) {
    const { token, env, url, command, args, ...rest } = rec;
    const view = { ...rest, token: token ? 'set' : null };
    if (url) { const u = new URL(url); view.url = `${u.origin}${u.pathname}`; view.urlHasQuery = Boolean(u.search); }
    if (rec.transport === 'stdio') { view.command = command; view.args = args; view.envKeys = Object.keys(env || {}); }
    return view;
  }

  function create({ label, transport, url, authHeader, token, command, args, env }) {
    if (!TRANSPORTS.has(transport)) throw new Error(`transport must be one of: ${[...TRANSPORTS].join(', ')}`);
    const rec = { id: crypto.randomUUID(), label: String(label || '').trim().slice(0, 80) || `${transport} server`, transport, createdAt: new Date().toISOString() };
    if (transport === 'http') {
      rec.url = cleanUrl(url);
      if (String(token || '').trim()) { rec.authHeader = String(authHeader || 'Authorization').trim(); rec.token = String(token).trim(); }
      const all = loadDisk(); all[rec.id] = rec; saveDisk(all);
    } else if (transport === 'pingone') {
      const all = loadDisk(); all[rec.id] = rec; saveDisk(all);
    } else {
      if (!String(command || '').trim()) throw new Error('command is required for stdio transport');
      rec.command = String(command).trim();
      rec.args = Array.isArray(args) ? args.map(String) : String(args || '').split(/\s+/).filter(Boolean);
      rec.env = env && typeof env === 'object' && !Array.isArray(env) ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) : {};
      session.set(rec.id, rec);
    }
    return rec;
  }

  const get = (id) => session.get(id) || loadDisk()[id] || null;
  const list = () => [...Object.values(loadDisk()), ...session.values()];
  function remove(id) {
    if (session.delete(id)) return true;
    const all = loadDisk();
    if (!all[id]) return false;
    delete all[id]; saveDisk(all); return true;
  }
  // Every secret string a connection holds, for scrub().
  function secretsOf(rec) {
    let query = [];
    try { query = rec?.url ? [...new URL(rec.url).searchParams.values()] : []; } catch { /* no url */ }
    return [rec?.token, ...Object.values(rec?.env || {}), ...query].filter(Boolean);
  }

  return { create, get, list, remove, publicView, secretsOf, file };
}
