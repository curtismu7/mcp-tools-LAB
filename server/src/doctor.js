// Preflight checks shared by `npm run doctor` and GET /api/health. Synchronous, no network, never prints a value that
// could be a secret (no tokens, no env values). Each check: { id, level: 'pass' | 'info' | 'setup' | 'fail', detail }.
import fs from 'node:fs';
import { dataDir, pingoneEnabled } from './config.js';
import { mockOnly } from './mock.js';
import { allowedHostNames, assertBindAllowed, bindHost } from './security.js';

export function runChecks({ env = process.env } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'pass' : 'fail', `v${process.versions.node} (need >= 20)`);

  try {
    const host = assertBindAllowed(bindHost(env), env);
    add('bind', 'pass', env.MCPTOOLS_BIND ? `${host} (MCPTOOLS_BIND opt-in; also accepts ${allowedHostNames(env).length} extra Host name(s))` : `${host} (loopback)`);
  } catch (e) { add('bind', 'fail', e.message); }

  const dir = dataDir(env);
  if (mockOnly(env)) add('state-dir', 'pass', 'mock-only: nothing is stored or read on this host');
  else try {
    if (fs.existsSync(dir)) {
      const mode = fs.statSync(dir).mode & 0o777;
      add('state-dir', mode & 0o077 ? 'fail' : 'pass', `${dir} mode ${mode.toString(8)}${mode & 0o077 ? ' (must be 700: run chmod 700)' : ''}`);
      const file = `${dir}/connections.json`;
      if (fs.existsSync(file)) {
        const fm = fs.statSync(file).mode & 0o777;
        add('connections-file', fm & 0o077 ? 'fail' : 'pass', `mode ${fm.toString(8)}${fm & 0o077 ? ' (must be 600: run chmod 600)' : ''}`);
      }
    } else add('state-dir', 'pass', `${dir} does not exist yet (created with mode 700 on first save)`);
  } catch (e) { add('state-dir', 'fail', `cannot read ${dir}: ${e.code || 'error'}`); }

  if (pingoneEnabled(env)) {
    const ok = Boolean(env.PINGONE_ENVIRONMENT_ID && env.PINGONE_MCP_CLIENT_ID);
    add('pingone', ok ? 'info' : 'setup', ok ? 'enabled and configured (optional, untested here)' : 'MCPTOOLS_PINGONE=1 but PINGONE_ENVIRONMENT_ID and PINGONE_MCP_CLIENT_ID are not both set');
  } else add('pingone', 'pass', 'off (optional)');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
export const needsSetup = (checks) => checks.some((c) => c.level === 'setup');
