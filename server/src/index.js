import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { port as configPort } from './config.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost } from './security.js';

// Local runs read the repo-root .env (real env vars win).
try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* no .env */ }

// Boot on `port` (0 = ephemeral). Refuses a non-loopback host unless MCPTOOLS_BIND is set.
export function startHttpServer({ port = configPort(), host = bindHost(), app = createApp() } = {}) {
  assertBindAllowed(host);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('error', reject);
    server.once('listening', () => {
      const { port: bound } = server.address();
      resolve({
        port: bound, url: `http://127.0.0.1:${bound}/`,
        close: async () => { await app.locals.manager.closeAll(); await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); },
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checks = runChecks();
  if (!allPassed(checks)) {
    for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[mcp-tools] refusing to start: ${c.id}: ${c.detail}`);
    process.exit(1);
  }
  const { url } = await startHttpServer();
  console.log(`[mcp-tools] listening on ${url} (loopback unless MCPTOOLS_BIND is set)`);
  process.on('SIGTERM', () => process.exit(0));
}
