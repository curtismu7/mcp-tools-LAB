// OPTIONAL extra. The always-on criterion test is hostile.fixture.test.js (a committed snapshot, no checkout needed).
// This one scans the REAL hostile server. It is cloned fresh (git clone from a local checkout, then npm ci) into a temp
// directory and run on a free loopback port, so what is scanned is the committed code, never a modified working tree.
// The source checkout is only read. Set HOSTILE_MCP_SRC to its path (default: ../../hostile-mcp next to this repo);
// the test is skipped, loudly, when that checkout is not there. Needs git and npm (the install may use the network
// or the npm cache).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startApp } from './helpers.js';
import { assertHostileScan } from './hostileAssertions.js';

const SRC = path.resolve(process.env.HOSTILE_MCP_SRC || fileURLToPath(new URL('../../../hostile-mcp', import.meta.url)));
const CLI = fileURLToPath(new URL('../src/scanner/cli.js', import.meta.url));
const present = fs.existsSync(path.join(SRC, '.git'));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// hostile-mcp cannot bind port 0 (PORT=0 falls back to its default 4701), so a free port is probed first and the pick
// can lose a race to another process. Each attempt therefore (a) watches the child, so an early exit (EADDRINUSE, a
// failed preflight) fails at once with its output instead of a silent wait, (b) accepts only a demo-health/1 answer
// naming hostile-mcp, so a stranger on that port is not mistaken for the server, and (c) polls with a per-request
// timeout inside a bounded deadline sized for a loaded machine. A lost port race is retried on a new port.
async function startHostileServer(clone, { attempts = 3, readyMs = 60_000 } = {}) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port) };
    delete env.HOSTILE_BIND;
    const child = spawn(process.execPath, ['server/src/index.js'], { cwd: clone, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let exited = null;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => { output = (output + c).slice(-2000); });
    child.once('exit', (code, signal) => { exited = `code ${code} signal ${signal}`; });
    const end = Date.now() + readyMs;
    let why = '';
    while (!exited && Date.now() < end) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        const body = await res.json();
        if (body.schema === 'demo-health/1' && body.demo?.id === 'hostile-mcp') return { port, child };
        why = `unexpected health answer from port ${port}: HTTP ${res.status}`;
      } catch (e) { why = `health not answering yet (${e.name})`; }
      await new Promise((r) => setTimeout(r, 150));
    }
    child.kill();
    failures.push(`attempt ${attempt} on port ${port}: ${exited ? `hostile-mcp exited (${exited})` : `no demo-health/1 answer within ${readyMs} ms (${why})`}; output: ${output.trim() || '(none)'}`);
  }
  throw new Error(`hostile-mcp did not start from ${clone}\n${failures.join('\n')}`);
}

test(`${present ? '' : `SKIPPED: set HOSTILE_MCP_SRC (no hostile-mcp checkout at ${SRC}) - `}live scan of the real hostile server: poisoned tools flagged, benign ones not, the rug-pull shows on the second list`,
  { skip: present ? false : 'SKIPPED: set HOSTILE_MCP_SRC to a hostile-mcp checkout to run the live test', timeout: 300_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-hostile-'));
    const clone = path.join(work, 'hostile-mcp');
    let server; let app; let port;
    try {
      execFileSync('git', ['clone', '--quiet', SRC, clone], { stdio: 'pipe' });
      execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: clone, stdio: 'pipe' });
      assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: clone }).toString(), '', 'the clone is clean before the run');

      ({ port, child: server } = await startHostileServer(clone));
      const url = `http://127.0.0.1:${port}/mcp`;

      app = await startApp();
      const { json } = await app.call('POST', '/api/connections', { transport: 'http', label: 'hostile', url });
      assert.equal(json.test.ok, true, JSON.stringify(json.test));
      const id = json.connection.id;

      // List #1 is the clean one for the process-wide rug-pull tool.
      const first = (await app.call('POST', `/api/connections/${id}/scan`, { trustedNames: ['get_balance'] })).json;
      const second = (await app.call('POST', `/api/connections/${id}/scan`, {})).json;
      assertHostileScan(first, second);

      // The CLI against the same server: exit 1 (findings), valid scan-report/1 JSON.
      const cli = spawn(process.execPath, [CLI, url, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      cli.stdout.on('data', (c) => { out += c; });
      const code = await new Promise((r) => cli.on('close', r));
      assert.equal(code, 1);
      assert.equal(JSON.parse(out).schema, 'scan-report/1');
    } finally {
      await app?.close();
      server?.kill();
      if (!process.env.MCPTOOLS_KEEP_CLONE) fs.rmSync(work, { recursive: true, force: true });
    }
  });
