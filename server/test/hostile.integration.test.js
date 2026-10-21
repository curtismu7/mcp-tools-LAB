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
async function waitFor(url, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test(`${present ? '' : `SKIPPED: set HOSTILE_MCP_SRC (no hostile-mcp checkout at ${SRC}) - `}live scan of the real hostile server: poisoned tools flagged, benign ones not, the rug-pull shows on the second list`,
  { skip: present ? false : 'SKIPPED: set HOSTILE_MCP_SRC to a hostile-mcp checkout to run the live test', timeout: 300_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-hostile-'));
    const clone = path.join(work, 'hostile-mcp');
    let server; let app;
    try {
      execFileSync('git', ['clone', '--quiet', SRC, clone], { stdio: 'pipe' });
      execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: clone, stdio: 'pipe' });
      assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: clone }).toString(), '', 'the clone is clean before the run');

      const port = await freePort();
      const env = { ...process.env, PORT: String(port) };
      delete env.HOSTILE_BIND;
      server = spawn(process.execPath, ['server/src/index.js'], { cwd: clone, env, stdio: 'ignore' });
      await waitFor(`http://127.0.0.1:${port}/api/health`);
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
