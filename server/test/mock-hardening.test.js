// Hardening for MOCK_ONLY: fail-closed flag, own-property fixtures, a netguard over every route, and the redundant defence layers.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createManager } from '../src/mcp/manager.js';
import { createMockClient, createMockStore, mockBodyAllowed, mockOnly } from '../src/mock.js';
import { pingoneEnabled } from '../src/config.js';
import { startApp } from './helpers.js';

const T = { timeout: 30_000 };
const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('flag: on values, off values, and every other value throws', T, () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'On', ' on ']) assert.equal(mockOnly({ MOCK_ONLY: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'False', ' ']) assert.equal(mockOnly({ MOCK_ONLY: v }), false, String(v));
  for (const v of ['True1', 'ye', 'enabled', '2', 'no', 'off', 'tru', '1 1']) assert.throws(() => mockOnly({ MOCK_ONLY: v }), /MOCK_ONLY/, v);
});

test('flag: createApp refuses a typo instead of falling back to live mode', T, async () => {
  await assert.rejects(startApp({ env: { MOCK_ONLY: 'True1' } }), /MOCK_ONLY/);
});

test('flag: the process will not boot on a typo (clear error, non-zero exit)', T, () => {
  const r = cp.spawnSync(process.execPath, ['src/index.js'], { cwd: SERVER_ROOT, env: { ...process.env, MOCK_ONLY: 'yess', PORT: '0' }, encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MOCK_ONLY has an unrecognised value/);
});

test('flag: yes and on switch mock mode on end to end; /api/config reports mockOnly true and stdio false', T, async () => {
  for (const v of ['yes', 'ON']) {
    const app = await startApp({ env: { MOCK_ONLY: v } });
    try {
      const cfg = (await app.call('GET', '/api/config')).json;
      assert.equal(cfg.mockOnly, true);
      assert.equal(cfg.stdio, false);
      assert.equal((await app.call('POST', '/api/connections', { transport: 'http', url: 'http://x.invalid/' })).status, 403);
    } finally { await app.close(); }
  }
});

test('fixtures: only own string keys; __proto__, constructor, arrays and non-strings are refused', T, async () => {
  const bad = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ['sample'], { a: 1 }, 1, null, true];
  for (const fixture of bad) {
    assert.equal(mockBodyAllowed({ transport: 'mock', fixture }), false, JSON.stringify(fixture));
    assert.throws(() => createMockStore().create({ transport: 'mock', fixture }), /unknown fixture/, JSON.stringify(fixture));
    assert.throws(() => createMockClient(fixture), /unknown fixture/, JSON.stringify(fixture));
  }
  assert.equal(mockBodyAllowed({ transport: 'mock', fixture: 'sample' }), true);
  const app = await startApp({ env: { MOCK_ONLY: '1' } });
  try {
    for (const raw of ['{"transport":"mock","fixture":"__proto__"}', '{"transport":"mock","fixture":"constructor"}', '{"transport":"mock","fixture":["sample"]}']) {
      const r = await app.call('POST', '/api/connections', raw, { raw: true, headers: { 'Content-Type': 'application/json' } });
      assert.equal(r.status, 403, raw);
      assert.equal(r.json.error, 'mock_only');
    }
  } finally { await app.close(); }
});

test('defence in depth: the manager refuses a non-mock connection in mock mode', T, () => {
  const store = { get: () => ({ id: 'x', transport: 'http', url: 'http://x.invalid/' }) };
  assert.throws(() => createManager({ store, mock: true }).client('x'), (e) => e.code === 'mock_only');
});

test('defence in depth: mock mode ignores .env and never enables PingOne', T, () => {
  assert.equal(pingoneEnabled({ MOCK_ONLY: '1', MCPTOOLS_PINGONE: '1' }), false);
  assert.equal(pingoneEnabled({ MCPTOOLS_PINGONE: '1' }), true);
  const envFile = `${REPO_ROOT}.env`;
  if (fs.existsSync(envFile)) return; // never touch a real .env
  const probe = "import('./src/index.js').then(() => console.log('CANARY=' + (process.env.MOCKFIX_CANARY || 'unset')))";
  try {
    fs.writeFileSync(envFile, 'MOCKFIX_CANARY=loaded\n');
    const run = (flag) => cp.spawnSync(process.execPath, ['-e', probe], { cwd: SERVER_ROOT, env: { PATH: process.env.PATH, MOCK_ONLY: flag }, encoding: 'utf8', timeout: 20_000 }).stdout;
    assert.match(run('1'), /CANARY=unset/);
    assert.match(run('0'), /CANARY=loaded/); // the probe itself works, so "unset" above is meaningful
  } finally { fs.rmSync(envFile, { force: true }); }
});

// ---- rule 18 netguard -----------------------------------------------------
// Blocks and records every socket connect (except to the app's own port), DNS lookup/resolve and child process.
function installGuard() {
  const attempts = [];
  let allowed = -1;
  const saved = [];
  const patch = (obj, key, make) => { const orig = obj[key]; if (typeof orig !== 'function') return; saved.push([obj, key, orig]); obj[key] = make(orig); };
  const block = (kind, target) => { attempts.push({ kind, target }); throw new Error(`netguard: blocked ${kind} ${target}`); };
  patch(net.Socket.prototype, 'connect', (orig) => function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = typeof first === 'object' && first ? first : { port: first, host: args[1] };
    if (o.path || Number(o.port) !== allowed || !['127.0.0.1', '::1', 'localhost', undefined].includes(o.host)) block('connect', o.path ? `unix:${o.path}` : `${o.host}:${o.port}`);
    return orig.apply(this, args);
  });
  const loopbackName = (h) => ['127.0.0.1', '::1', 'localhost'].includes(h); // the test client's own fetch to the app
  for (const k of ['lookup', 'lookupService', ...Object.getOwnPropertyNames(dns.Resolver.prototype).filter((n) => /^(resolve|reverse)/.test(n))]) {
    patch(dns, k, (orig) => (...a) => (k === 'lookup' && loopbackName(a[0]) ? orig.apply(dns, a) : block('dns', `${k}(${String(a[0])})`)));
  }
  for (const k of Object.keys(dns.promises)) patch(dns.promises, k, () => async (...a) => block('dns', `promises.${k}(${String(a[0])})`));
  for (const k of ['lookup', 'lookupService', ...Object.getOwnPropertyNames(dns.Resolver.prototype).filter((n) => /^(resolve|reverse)/.test(n))]) patch(dns.Resolver.prototype, k, () => function (...a) { return block('dns', `Resolver.${k}(${String(a[0])})`); });
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(cp, k, () => (...a) => block('process', `${k}(${String(a[0])})`));
  return { attempts, allow(p) { allowed = p; }, uninstall() { for (const [o, k, f] of saved.reverse()) o[k] = f; } };
}

test('netguard self-test: the guard fires on connect, DNS and child processes, and uninstalls cleanly', T, async () => {
  const g = installGuard();
  try {
    assert.throws(() => net.connect(9, '192.0.2.1'), /netguard/);
    assert.throws(() => dns.lookup('host.invalid', () => {}), /netguard/);
    await assert.rejects(dns.promises.lookup('host.invalid'), /netguard/);
    assert.throws(() => new dns.Resolver().resolve4('host.invalid', () => {}), /netguard/);
    assert.throws(() => cp.spawn('true'), /netguard/);
    assert.throws(() => cp.exec('true'), /netguard/);
    assert.throws(() => cp.execFileSync('true'), /netguard/);
    assert.deepEqual([...new Set(g.attempts.map((a) => a.kind))].sort(), ['connect', 'dns', 'process']);
  } finally { g.uninstall(); }
  assert.equal(typeof cp.spawn('true').pid, 'number'); // really restored
});

test('netguard: every route in mock mode makes zero outbound connections, DNS lookups or child processes', T, async () => {
  const g = installGuard();
  const app = await startApp({ env: { MOCK_ONLY: '1', MCPTOOLS_PINGONE: '1' } });
  try {
    g.allow(app.port);
    const { call } = app;
    const seen = [];
    const hit = async (m, p, b) => { const r = await call(m, p, b); seen.push(`${m} ${p} ${r.status}`); return r; };
    await hit('GET', '/api/health'); await hit('GET', '/api/config'); await hit('GET', '/api/rules'); await hit('GET', '/api/protocol-methods');
    await hit('GET', '/api/connections'); await hit('GET', '/');
    for (const body of [{ transport: 'http', url: 'http://192.0.2.1/' }, { transport: 'stdio', command: 'node' }, { transport: 'pingone' }, { transport: 'mock', fixture: '__proto__' }]) assert.equal((await hit('POST', '/api/connections', body)).status, 403);
    for (const p of ['GET /api/pingone/status', 'GET /api/pingone/callback', 'POST /api/pingone/login']) { const [m, u] = p.split(' '); assert.equal((await hit(m, u, m === 'POST' ? {} : undefined)).status, 403); }
    for (const fixture of ['sample', 'hostile']) {
      const id = (await hit('POST', '/api/connections', { transport: 'mock', fixture })).json.connection.id;
      await hit('POST', `/api/connections/${id}/test`, {}); await hit('GET', `/api/connections/${id}/tools`);
      await hit('POST', `/api/connections/${id}/scan`, {});
      const pv = await hit('POST', `/api/connections/${id}/call/preview`, { tool: 'add', arguments: { a: 1, b: 2 } });
      await hit('POST', `/api/connections/${id}/call`, { tool: 'add', arguments: { a: 1, b: 2 }, confirm: true, argsHash: pv.json.argsHash });
      for (const m of [{ method: 'resources/list' }, { method: 'prompts/list' }, { method: 'logging/setLevel', params: { level: 'info' } }]) {
        const rp = await hit('POST', `/api/connections/${id}/rpc/preview`, m);
        await hit('POST', `/api/connections/${id}/rpc`, { ...m, confirm: true, argsHash: rp.json.argsHash });
      }
    }
    await hit('POST', '/api/scan', { snapshot: { tools: [{ name: 'a', description: 'b', inputSchema: { type: 'object' } }] } });
    await hit('DELETE', '/api/connections/mock-sample');
    assert.ok(seen.length > 30, `exercised ${seen.length} requests`);
    assert.ok(!seen.some((s) => / 5\d\d$/.test(s)), seen.filter((s) => / 5\d\d$/.test(s)).join(', '));
  } finally { g.uninstall(); await app.close(); }
  assert.deepEqual(g.attempts, [], 'no blocked attempt of any kind');
});
