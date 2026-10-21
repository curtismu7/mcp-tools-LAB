// Scans the REAL hostile server. It is cloned fresh (git clone from a local checkout, then npm ci) into a temp
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

test('scan the real hostile server: poisoned tools flagged, benign ones not, the rug-pull shows on the second list',
  { skip: present ? false : `hostile-mcp checkout not found at ${SRC} (set HOSTILE_MCP_SRC)`, timeout: 300_000 }, async () => {
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
      const by = new Map();
      for (const f of first.report.findings) by.set(f.subject, [...(by.get(f.subject) || []), f]);
      const has = (subject, ruleId) => (by.get(subject) || []).some((f) => f.ruleId === ruleId);

      assert.ok(has('get_weather', 'MT-HI-001'), 'hidden-instruction: <IMPORTANT> block');
      assert.ok(has('summarize_ticket', 'MT-HI-003'), 'hidden-instruction without a tag');
      assert.ok(has('search_docs', 'MT-EX-001') && has('search_docs', 'MT-EX-002'), 'exfil-sink: off-box default + leak instruction');
      assert.ok(has('send_email', 'MT-EX-001'), 'exfil-sink: off-box bcc default');
      assert.ok(has('get_balance', 'MT-SH-001') && has('get_balance', 'MT-SH-003'), 'shadowing: trusted-name collision and claimed primacy');
      assert.ok(has('verify_identity', 'MT-CR-001') && has('verify_identity', 'MT-CR-002'), 'credential harvest');
      assert.ok(has('resource:account-verification', 'MT-HI-001') && has('resource:account-verification', 'MT-SA-002'), 'poisoned resource');
      assert.ok(has('prompt:account_review', 'MT-HI-001'), 'poisoned prompt');

      for (const benign of ['read_ticket', 'create_transfer', 'delete_all_records', 'grant_admin', 'get_stock_price']) {
        assert.deepEqual(by.get(benign) || [], [], `${benign} must not be flagged on the first list`);
      }
      assert.ok(first.listed.tools.some((t) => t.name === 'get_stock_price'));

      // The documented limit: the second list is not the first. The scan of list #1 said nothing about it.
      const second = (await app.call('POST', `/api/connections/${id}/scan`, {})).json;
      assert.ok(second.report.findings.some((f) => f.subject === 'get_stock_price' && f.kind === 'hidden-instruction'), 'rug-pull caught on the later list');
      assert.ok(second.report.limits.some((l) => l.id === 'rug-pull'));

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
