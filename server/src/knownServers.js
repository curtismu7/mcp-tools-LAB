// The MCP servers this family runs on this machine, so the Connect page can fill the form for you. The list is a committed
// file (loopback addresses only, no secrets); whether each one is running is checked now, with a bare TCP connect.
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../data/known-servers.json', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SERVERS = 20;
const FIELDS = new Set(['id', 'label', 'transport', 'url', 'authHeader', 'note', 'start', 'needsToken']);
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// Throws on anything that is not a plain loopback http server entry: a wrong address must fail loudly, not be probed.
export function validateKnownServers(doc) {
  if (!doc || doc.schema !== 'known-servers/1' || !Array.isArray(doc.servers)) throw new Error('known-servers: expected {schema:"known-servers/1", servers:[...]}');
  if (doc.servers.length > MAX_SERVERS) throw new Error(`known-servers: at most ${MAX_SERVERS} servers`);
  const seen = new Set();
  return doc.servers.map((s) => {
    for (const k of Object.keys(s)) if (!FIELDS.has(k)) throw new Error(`known-servers: unexpected field "${k}" (secrets never belong in this file)`);
    if (!ID.test(s.id || '') || seen.has(s.id)) throw new Error(`known-servers: bad or duplicate id "${s.id}"`);
    seen.add(s.id);
    if (s.transport !== 'http') throw new Error(`known-servers: ${s.id}: only http entries are supported`);
    if (!text(s.label, 120) || !text(s.note ?? 'x', 300) || !text(s.start ?? 'x', 600)) throw new Error(`known-servers: ${s.id}: label, note or start is missing or too long`);
    let u;
    try { u = new URL(s.url); } catch { throw new Error(`known-servers: ${s.id}: url is not a URL`); }
    if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || u.username || u.password || !u.port) throw new Error(`known-servers: ${s.id}: url must be http on a loopback host with an explicit port and no credentials`);
    if (s.needsToken !== undefined && typeof s.needsToken !== 'boolean') throw new Error(`known-servers: ${s.id}: needsToken must be true or false`);
    return { id: s.id, label: s.label, transport: 'http', url: s.url, authHeader: s.authHeader || 'Authorization', note: s.note || '', start: s.start || '', needsToken: s.needsToken === true };
  });
}

export function loadKnownServers(file = FILE) { return validateKnownServers(JSON.parse(fs.readFileSync(file, 'utf8'))); }

// Is something listening at this loopback URL? A TCP connect only: no request is sent, so nothing is initialized or logged by the server.
export function probe(url, timeoutMs = 600) {
  const u = new URL(url);
  const host = u.hostname === '[::1]' ? '::1' : u.hostname;
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(u.port) });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export async function listKnownServers({ servers = loadKnownServers(), probe: check = probe } = {}) {
  return Promise.all(servers.map(async (s) => ({ ...s, running: await check(s.url).catch(() => false) })));
}
