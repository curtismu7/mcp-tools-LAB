// Preflight: the same checks GET /api/health reports from, plus whether the port is free.
// Prints only pass/fail lines, never the value of a setting. Exit 1 on any failure. Needs no network.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* optional */ }

const { runChecks } = await import(pathToFileURL(path.join(root, 'server/src/doctor.js')));
const { port: configPort } = await import(pathToFileURL(path.join(root, 'server/src/config.js')));
let failed = 0;
const report = (level, name, detail) => {
  if (level === 'fail') failed++;
  console.log(`${level.toUpperCase().padEnd(5)} ${name}: ${detail}`);
};

for (const c of runChecks()) report(c.level, c.id, c.detail);

const port = configPort();
await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => { report('fail', 'port', `${port} is not free (${e.code}). Set PORT in .env to a free port`); resolve(); });
  s.listen(port, '127.0.0.1', () => s.close(() => { report('pass', 'port', `${port} is free`); resolve(); }));
});

process.exit(failed ? 1 : 0);
