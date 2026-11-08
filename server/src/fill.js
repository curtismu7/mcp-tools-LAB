// What the call form may fill in for a person (owner 2026-11-07: "the user will not know account_id or user id: fill
// them in, and let them change it"). This module answers two of the four sources; the page adds the other two.
//  - demo: plain sample values for our own servers (data/sample-values.json, matched to known-servers.json by URL);
//  - identity: who is signed in to this connection (pi.flow or OAuth), read from the access token's claims when it is
//    a JWT: sub, email, preferred_username, name. Never the token itself.
// The page adds: "Pick" (look ids up with the server's own read-only list tool, behind the normal confirm) and safe
// values from the server's schema (never a URL, email, host or path; never on a flagged tool).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadKnownServers } from './knownServers.js';

const FILE = fileURLToPath(new URL('../data/sample-values.json', import.meta.url));
const MAX_VALUES = 40;
const plain = (v) => (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

export function loadSampleValues(file = FILE) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc?.schema !== 'sample-values/1' || !doc.servers || typeof doc.servers !== 'object') throw new Error('sample-values: expected {schema:"sample-values/1", servers:{}}');
  const out = new Map();
  for (const [id, values] of Object.entries(doc.servers)) {
    const clean = Object.fromEntries(Object.entries(values || {}).filter(([k, v]) => /^[A-Za-z0-9_]{1,60}$/.test(k) && plain(v)).slice(0, MAX_VALUES));
    out.set(id, clean);
  }
  return out;
}

// The claims of a JWT access token, decoded only (not verified: this is for filling a form, never for trust).
export function identityFrom(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length !== 3) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object') return null;
  const pick = (k) => (typeof claims[k] === 'string' && claims[k].length <= 200 ? claims[k] : undefined);
  const id = { sub: pick('sub'), email: pick('email'), username: pick('preferred_username') || pick('username'), name: pick('name') };
  return Object.values(id).some(Boolean) ? Object.fromEntries(Object.entries(id).filter(([, v]) => v)) : null;
}

export function createFill({ known = () => loadKnownServers(), samples = loadSampleValues() } = {}) {
  return {
    demoFor(conn) {
      if (!conn?.url) return {};
      let list = [];
      try { list = known(); } catch { return {}; }
      const hit = list.find((s) => s.url === conn.url);
      return hit ? { ...(samples.get(hit.id) || {}) } : {};
    },
  };
}
