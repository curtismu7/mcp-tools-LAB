// Our PingOne environment, for pi.flow sign-in (rule 16). The values come from the family's one settings file
// (~/Development/.env, or STANDALONE_ENV), loaded at startup by index.js; tests pass their own env and read no file.
// The issuer is https://auth.pingone.<region>/<environment id>/as. MCPTOOLS_P1_ISSUER replaces it (tests point it at
// a fake PingOne on loopback); it only ever selects pi.flow, never a redirect sign-in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

const REGION_ALIASES = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' }; // as pingone-LAB settings.js
export const P1_KEYS = ['PINGONE_ENVIRONMENT_ID', 'PINGONE_REGION', 'PINGONE_MCP_CLIENT_ID', 'MCPTOOLS_P1_SCOPES', 'MCPTOOLS_P1_RESOURCES']; // the last two are settings, not secrets

export function p1Config(env = process.env) {
  const environmentId = String(env.PINGONE_ENVIRONMENT_ID || '').trim();
  const region = REGION_ALIASES[String(env.PINGONE_REGION || '').trim().toLowerCase()] || 'com';
  let override = String(env.MCPTOOLS_P1_ISSUER || '').trim();
  try { const u = new URL(override); if (!(u.protocol === 'https:' || (u.protocol === 'http:' && /^(127(\.\d+){3}|localhost|\[?::1\]?)$/.test(u.hostname)))) override = ''; } catch { override = ''; } // a password never goes over plain http to a non-loopback host
  const issuer = override || (environmentId ? `https://auth.pingone.${region}/${environmentId}/as` : null);
  return { environmentId, region, issuer, clientId: String(env.PINGONE_MCP_CLIENT_ID || '').trim() || null };
}
export const sameIssuer = (a, b) => Boolean(a && b) && String(a).replace(/\/$/, '') === String(b).replace(/\/$/, '');

// Startup only: copy the P1 keys from the shared settings file into the process env (real env vars win). Nothing else
// from that file is read, so other apps' secrets never enter this process.
export function loadSharedP1(env = process.env) {
  const file = env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env');
  let parsed = {};
  try { parsed = parseEnv(fs.readFileSync(file, 'utf8')); } catch { return; }
  for (const k of P1_KEYS) if (!env[k] && typeof parsed[k] === 'string' && parsed[k]) env[k] = parsed[k];
}
