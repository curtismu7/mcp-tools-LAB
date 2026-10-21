import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { allPassed, needsSetup, runChecks } from '../src/doctor.js';
import { createHealth } from '../src/health.js';
import { tmpDir } from './helpers.js';

const level = (checks, id) => checks.find((c) => c.id === id)?.level;

test('doctor: defaults pass; a non-loopback bind without opt-in fails', () => {
  const env = { DATA_DIR: tmpDir() };
  assert.ok(allPassed(runChecks({ env })));
  assert.equal(level(runChecks({ env: { ...env, MCPTOOLS_BIND: '0.0.0.0' } }), 'bind'), 'pass');
});

test('doctor: a state directory or connections file with group/other access fails', () => {
  const dir = tmpDir();
  fs.chmodSync(dir, 0o755);
  assert.equal(level(runChecks({ env: { DATA_DIR: dir } }), 'state-dir'), 'fail');
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'connections.json'), '{}', { mode: 0o644 });
  assert.equal(level(runChecks({ env: { DATA_DIR: dir } }), 'connections-file'), 'fail');
  fs.chmodSync(path.join(dir, 'connections.json'), 0o600);
  assert.ok(allPassed(runChecks({ env: { DATA_DIR: dir } })));
});

test('doctor never prints a setting value that could be a secret', () => {
  const env = { DATA_DIR: tmpDir(), MCPTOOLS_PINGONE: '1', PINGONE_ENVIRONMENT_ID: 'env-id-should-not-print', PINGONE_MCP_CLIENT_ID: 'client-id-should-not-print' };
  const text = JSON.stringify(runChecks({ env }));
  assert.ok(!text.includes('should-not-print'));
  assert.equal(level(runChecks({ env }), 'pingone'), 'info');
  assert.ok(needsSetup(runChecks({ env: { DATA_DIR: env.DATA_DIR, MCPTOOLS_PINGONE: '1' } })));
});

test('health maps checks to ready / needs-setup / broken / unknown', () => {
  const state = (runChecks) => { const h = createHealth({ runChecks }); let body; h.router.handle({ method: 'GET', url: '/', headers: {} }, { set() {}, json(b) { body = b; } }, () => {}); h.stop(); return body.state; };
  assert.equal(state(() => [{ level: 'pass' }]), 'ready');
  assert.equal(state(() => [{ level: 'setup' }]), 'needs-setup');
  assert.equal(state(() => [{ level: 'fail' }, { level: 'setup' }]), 'broken');
  assert.equal(state(() => { throw new Error('x'); }), 'unknown');
});
