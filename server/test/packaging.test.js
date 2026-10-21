// Docker, shelf entry, content pack and generated docs. Patterns from hostile-mcp scripts/compose.test.mjs and
// content-pack.test.mjs (same author).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PACK_PATH, buildPack, serialize } from '../../scripts/build-content-pack.mjs';
import { DOC_PATH, buildScanRules } from '../../scripts/build-scan-rules.mjs';
import { validatePack } from '../../scripts/validate-content-pack.mjs';
import { RULES } from '../src/scanner/rules.js';

// Committed copies of the two sibling-repo files this test compares against (see PROVENANCE.json for repo + commit).
// They make the checks run on any machine; the live sibling checkouts, when present, are an extra comparison.
const COPIES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'source-copies');
const copy = (name) => fs.readFileSync(path.join(COPIES, name), 'utf8');
const provenance = JSON.parse(copy('PROVENANCE.json')).files;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The list items under each `ports:` key (a small line parser; no YAML dependency).
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}

test('docker-compose.yml publishes only on 127.0.0.1', () => {
  const ports = publishedPorts(read('docker-compose.yml'));
  assert.ok(ports.length > 0, 'the parser found the published port');
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, `${p} must start with 127.0.0.1:`);
});

test('the port parser flags an unbound or wildcard publish', () => {
  for (const bad of ['- "4810:4810"', '- "0.0.0.0:4810:4810"', '- 4810']) {
    const ports = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(ports.length, 1);
    assert.doesNotMatch(ports[0], /^127\.0\.0\.1:/);
  }
});

test('the image is Node 22 and runs as a non-root user', () => {
  const d = read('Dockerfile');
  assert.match(d, /^FROM node:22/m);
  assert.match(d, /^USER node$/m);
  assert.ok(d.lastIndexOf('USER node') > d.lastIndexOf('RUN '), 'USER is set after the last RUN');
});

test('docs/shelf-entry.json holds valid shelf registry entries for D3 and D4 on port 4810', () => {
  const { demos } = JSON.parse(read('docs/shelf-entry.json'));
  assert.deepEqual(demos.map((d) => d.catalogId), ['D3', 'D4']);
  for (const d of demos) {
    assert.match(d.id, /^[a-z0-9-]{2,41}$/);
    assert.equal(d.url, 'http://localhost:4810');
    assert.equal(d.healthPath, '/api/health');
    assert.ok(d.composeFile.startsWith('/') && d.composeFile.endsWith('docker-compose.yml'), 'composeFile is an absolute path (the shipped value is the author\'s; README says how to override it)');
    assert.ok(d.name.length <= 300 && d.description.length <= 300);
  }
});

test('content-pack.json is exactly what the generator produces (run: node scripts/build-content-pack.mjs)', () => {
  assert.equal(fs.readFileSync(PACK_PATH, 'utf8'), serialize(buildPack()), 'content-pack.json is stale; regenerate it and commit the result');
});

test('content-pack.json validates against the schema, and the schema is the ID-JAG kit\'s', () => {
  assert.deepEqual(validatePack(JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))), []);
  const name = 'id-jag-content-pack.schema.json';
  assert.equal(sha(copy(name)), provenance[name].sha256, 'the committed kit schema copy matches its recorded sha256');
  assert.equal(read('docs/content-pack.schema.json'), copy(name), `docs/content-pack.schema.json is not byte-identical to the kit's schema at ${provenance[name].commit.slice(0, 9)}`);
  const kit = process.env.IDJAG_KIT_SRC || path.join(ROOT, '..', 'id-jag-standalone', 'docs', 'content-pack.schema.json');
  if (fs.existsSync(kit)) assert.equal(read('docs/content-pack.schema.json'), fs.readFileSync(kit, 'utf8'), 'also identical to the sibling checkout');
});

test('the validator rejects a broken pack', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['no-such-term'];
  delete pack.title;
  assert.ok(validatePack(pack).length >= 2);
});

test('the pack has the required terms, two story cards, and only the one source taken from a README', () => {
  const pack = buildPack();
  for (const id of ['tool-metadata', 'tool-poisoning', 'hidden-instruction', 'exfil-sink', 'name-shadowing', 'bidi-zero-width', 'scan-report', 'trust-on-first-use', 'confirm-gate', 'inspector']) assert.ok(pack.glossary.some((g) => g.id === id), id);
  assert.deepEqual(pack.cards.filter((c) => c.story).map((c) => c.story).sort(), ['S01', 'S02']);
  assert.deepEqual(pack.sources.map((s) => s.url), ['https://modelcontextprotocol.io']);
  const name = 'mcp-inspector-README.md';
  assert.equal(sha(copy(name)), provenance[name].sha256, 'the committed README copy matches its recorded sha256');
  assert.ok(copy(name).includes(pack.sources[0].url), `the source URL appears in the inspector README at ${provenance[name].commit.slice(0, 9)}`);
  assert.equal(JSON.stringify(pack).match(/pingone\.(com|eu|asia|ca)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g), null);
});

test('docs/scan-rules.md is exactly what the generator produces (run: node scripts/build-scan-rules.mjs)', () => {
  assert.equal(fs.readFileSync(DOC_PATH, 'utf8'), buildScanRules());
  for (const id of Object.keys(RULES)) assert.ok(read('docs/scan-rules.md').includes(`| ${id} |`), id);
});
