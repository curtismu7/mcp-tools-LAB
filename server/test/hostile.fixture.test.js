// ALWAYS-ON criterion test. Scans a committed, byte-exact snapshot of what the real hostile-mcp server serves
// (server/test/fixtures/hostile-snapshot.json, captured by scripts/capture-hostile-snapshot.mjs at the commit recorded
// inside it). No checkout, no network, no npm install: it runs on a clean clone and on any CI runner. The snapshot is
// replayed through a local MCP server, so the real connect -> list -> read -> scan path is exercised.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { digest } from '../../scripts/capture-hostile-snapshot.mjs';
import { startFakeMcp } from './fixtures/fakeMcp.js';
import { startApp } from './helpers.js';
import { assertHostileScan } from './hostileAssertions.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/hostile-snapshot.json', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const d = fixture.data;

test('the snapshot fixture is intact and records the hostile-mcp commit it came from', () => {
  assert.equal(fixture.schema, 'hostile-snapshot/1');
  assert.match(fixture.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(fixture.sha256, digest(d), 'fixture data was edited by hand; re-capture it with scripts/capture-hostile-snapshot.mjs');
  assert.equal(d.toolsList1.tools.length, 11);
});

test('freshness: warns (never fails) when the snapshot is older than a local hostile-mcp checkout', (t) => {
  const src = path.resolve(process.env.HOSTILE_MCP_SRC || fileURLToPath(new URL('../../../hostile-mcp', import.meta.url)));
  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no checkout */ }
  if (!head) { t.diagnostic(`freshness not checked: no hostile-mcp checkout at ${src}`); return; }
  if (head !== fixture.source.commit) {
    const msg = `WARNING: hostile-snapshot.json is from hostile-mcp ${fixture.source.commit.slice(0, 9)} but the checkout is at ${head.slice(0, 9)}. Re-run: node scripts/capture-hostile-snapshot.mjs`;
    t.diagnostic(msg);
    process.emitWarning(msg);
  } else t.diagnostic(`snapshot is current (hostile-mcp ${head.slice(0, 9)})`);
});

test('scan the committed hostile snapshot: every poisoned entry flagged, no benign one, rug-pull on list 2', { timeout: 60_000 }, async () => {
  const resources = d.resourcesList.resources.map((r) => ({ ...r, contents: d.resourcesRead[r.uri].contents }));
  const prompts = d.promptsList.prompts.map((p) => ({ ...p, messages: d.promptsGet[p.name].messages }));
  const srv = await startFakeMcp({ tools: d.toolsList1.tools, resources, prompts });
  const app = await startApp();
  try {
    const { json } = await app.call('POST', '/api/connections', { transport: 'http', label: 'hostile-snapshot', url: srv.url });
    assert.equal(json.test.ok, true, JSON.stringify(json.test));
    const id = json.connection.id;
    const first = (await app.call('POST', `/api/connections/${id}/scan`, { trustedNames: ['get_balance'] })).json;
    srv.state.tools = d.toolsList2.tools; // what the real server serves on its later list
    const second = (await app.call('POST', `/api/connections/${id}/scan`, {})).json;
    assertHostileScan(first, second);
    assert.ok(!srv.seen.methods.includes('tools/call'), 'a scan never executes a tool');
  } finally {
    await app.close();
    await srv.close();
  }
});
