#!/usr/bin/env node
// Captures what the real hostile-mcp server serves (tools/list twice, resources/list + resources/read, prompts/list +
// prompts/get) into server/test/fixtures/hostile-snapshot.json, so the always-on regression test needs no checkout
// and no network. The server is run from a CLEAN clone of a local checkout at its committed HEAD; the commit hash is
// recorded in the fixture.
//
//   node scripts/capture-hostile-snapshot.mjs [path-to-hostile-mcp-checkout]
//
// Default checkout: HOSTILE_MCP_SRC, else ../hostile-mcp next to this repo. Upstream: github.com/cmuir_pingcorp/hostile-mcp.
// Needs git and npm (the install may use the network or the npm cache). Re-run when the freshness check warns.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from '../server/src/mcp/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(root, 'server', 'test', 'fixtures', 'hostile-snapshot.json');
export const digest = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function waitFor(url, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main() {
  const src = path.resolve(process.argv[2] || process.env.HOSTILE_MCP_SRC || path.join(root, '..', 'hostile-mcp'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src }).toString().trim();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-capture-'));
  const clone = path.join(work, 'hostile-mcp');
  let server;
  try {
    execFileSync('git', ['clone', '--quiet', src, clone], { stdio: 'pipe' });
    execFileSync('git', ['checkout', '--quiet', commit], { cwd: clone, stdio: 'pipe' });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: clone, stdio: 'pipe' });
    const port = await freePort();
    const env = { ...process.env, PORT: String(port) };
    delete env.HOSTILE_BIND;
    server = spawn(process.execPath, ['server/src/index.js'], { cwd: clone, env, stdio: 'ignore' });
    await waitFor(`http://127.0.0.1:${port}/api/health`);
    const client = createHttpClient({ url: `http://127.0.0.1:${port}/mcp`, getAuth: () => null });
    await client.ensure?.();

    const data = {};
    data.toolsList1 = await client.rpc('tools/list', {});
    data.toolsList2 = await client.rpc('tools/list', {}); // the rug-pull: the process-wide tool changes on a later list
    data.resourcesList = await client.rpc('resources/list', {});
    data.resourcesRead = {};
    for (const r of data.resourcesList.resources) data.resourcesRead[r.uri] = await client.rpc('resources/read', { uri: r.uri });
    data.promptsList = await client.rpc('prompts/list', {});
    data.promptsGet = {};
    for (const p of data.promptsList.prompts) {
      const args = Object.fromEntries((p.arguments || []).map((a) => [String(a.name), 'demo-value']));
      data.promptsGet[p.name] = await client.rpc('prompts/get', { name: p.name, arguments: args });
    }
    const fixture = {
      schema: 'hostile-snapshot/1',
      source: { repo: 'https://github.com/cmuir_pingcorp/hostile-mcp', commit },
      capturedBy: 'node scripts/capture-hostile-snapshot.mjs',
      sha256: digest(data),
      data,
    };
    fs.writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${path.relative(root, FIXTURE)} from hostile-mcp ${commit}`);
  } finally {
    server?.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
