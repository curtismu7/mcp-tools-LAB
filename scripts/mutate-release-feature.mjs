#!/usr/bin/env node
// Mutation check for the entitled-listing feature (Ping release claim of 2026-11-02, UNVERIFIED on our tenant).
// For each mutant it changes ONE thing in a source file, runs the tests that should notice, and expects them to FAIL.
// A mutant that passes the tests "survived" and the script exits 1. The file is always put back, even on Ctrl-C.
// Every mutant names the exact text it replaces and how many times that text occurs, so a mutant can never silently
// do nothing (a wrong count is an error, not a pass).
//
//   node scripts/mutate-release-feature.mjs            all mutants, one at a time (about ten minutes)
//   node scripts/mutate-release-feature.mjs M05 W03    only these
//
// Run it with the test env pointing at no settings file:  STANDALONE_ENV=/nonexistent node scripts/mutate-release-feature.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = {
  cwd: path.join(ROOT, 'server'),
  steps: [
    ['engine', ['--test', '--test-timeout=60000', 'test/gateway.engine.test.js']],
    ['api', ['--test', '--test-timeout=60000', 'test/gateway.api.test.js']],
  ],
};
const WEB = (file) => ({ cwd: path.join(ROOT, 'web'), steps: [['web', null, ['npx', 'vitest', 'run', file]]] });
const GW_PAGE = 'src/pages/__tests__/gateway.test.jsx';
const GW_LIB = 'src/lib/__tests__/gateway.test.js';
const SIM = 'server/src/gateway/sim.js';
const CONFIG = 'server/src/gateway/config.js';
const ROUTES = 'server/src/gateway/routes.js';

// [id, field or behaviour, file, exact text, occurrences in the file, which one (0-based), replacement, runner]
const AGG_REACH = "  if (!m.reachable) return 'unreachable';\n";
const UP = "  if (m.upstream === 'per-user' && !m.linked.has(caller)) return 'upstream-sign-in';\n";
const POLICY = "  if (!allows(m.policy, caller, tool)) return 'member-policy';\n";
const CAP = "  if (!allows(cfg.cap, caller, q(m, tool))) return 'aggregate-cap';\n";
export const MUTANTS = [
  ['M01', 'policy field members[].reachable ignored by the listing', SIM, AGG_REACH, 3, 0, '', SERVER],
  ['M02', 'an unreachable member is swallowed (reported as ok)', SIM, "(!m.reachable ? 'unreachable' :", 1, 0, "(false ? 'unreachable' :", SERVER],
  ['M03', 'policy field members[].upstream / linkedCallers ignored by the listing', SIM, UP, 2, 0, '', SERVER],
  ['M04', 'policy field members[].toolFilter ignored', SIM, "  if (!m.toolFilter.has(tool)) return 'tool-filter';\n", 1, 0, '', SERVER],
  ['M05', 'policy field members[].policy ignored by the listing (cap becomes a grant)', SIM, POLICY, 3, 0, '', SERVER],
  ['M06', 'policy field cap ignored by the listing', SIM, CAP, 2, 0, '', SERVER],
  ['M07', 'the cap is not enforced again at the member hop', SIM, CAP, 2, 1, '', SERVER],
  ['M08', 'the call-time re-check (entry) is dropped', SIM, 'export function stageEntry(cfg, m, tool, caller) { return aggregateLayer(cfg, m, tool, caller); }', 1, 0, 'export function stageEntry(cfg, m, tool, caller) { return null; }', SERVER],
  ['M09', 'policy field members[].alias: the alias prefix is removed', SIM, 'const q = (m, tool) => `${m.alias}__${tool}`;', 1, 0, 'const q = (m, tool) => tool;', SERVER],
  ['M10', 'default deny becomes default allow for a caller with no entry', SIM, "const allows = (map, caller, name) => map.get(caller)?.has(name) === true;", 1, 0, "const allows = (map, caller, name) => (map.has(caller) ? map.get(caller).has(name) : true);", SERVER],
  ['M11', 'the member hop stops checking the member policy', SIM, POLICY, 3, 2, '', SERVER],
  ['M12', 'the member hop stops checking reachability', SIM, AGG_REACH, 3, 2, '', SERVER],
  ['M13', 'a direct member listing applies the aggregate rules (negative control)', SIM, 'if (directLayer(m, t.name, caller) === null) tools.push(entry(t, t.name));', 1, 0, 'if (aggregateLayer(cfg, m, t.name, caller) === null) tools.push(entry(t, t.name));', SERVER],
  ['M14', 'a direct member call ignores the member upstream sign-in', SIM, UP, 2, 1, '', SERVER],
  ['M15', 'a direct member call ignores an unreachable member', SIM, AGG_REACH, 3, 1, '', SERVER],
  ['M16', 'the refusal words differ by layer (leaks existence)', SIM, "const refused = (trace) => ({ ok: false, ...NOT_AVAILABLE, trace });", 1, 0, "const refused = (trace) => ({ ok: false, ...NOT_AVAILABLE, message: `${REFUSAL} ${trace[0].layer}`, trace });", SERVER],
  ['M17', 'the listing reports a count of hidden tools (leak)', SIM, 'return { tools, members: cfg.members.map((m) => ({ alias: m.alias, status: status(m, caller) })) };', 1, 0, 'return { hidden: 1, tools, members: cfg.members.map((m) => ({ alias: m.alias, status: status(m, caller) })) };', SERVER],
  ['M18', 'a typed credential is no longer refused', CONFIG, "export const credentialLike = (s) => typeof s === 'string' && CREDENTIAL.some((re) => re.test(s));", 1, 0, 'export const credentialLike = () => false;', SERVER],
  ['M19', 'unknown config fields are accepted', CONFIG, "    if (!allowed.includes(k)) throw new ConfigError(where, 'unexpected field');", 1, 0, '    void k;', SERVER],
  ['M20', 'a duplicate alias is accepted', CONFIG, "if (!nameOk(m.alias, ALIAS) || aliases.has(m.alias))", 1, 0, 'if (!nameOk(m.alias, ALIAS))', SERVER],
  ['M21', 'a policy naming a tool the member lacks is accepted', CONFIG, "if (!toolNames.has(n)) throw new ConfigError(where, 'names a tool the member does not have');", 1, 0, 'void n;', SERVER],
  ['M22', 'a cap naming a tool no member has is accepted', CONFIG, "if (!qualifiedAll.has(q)) throw new ConfigError('cap', 'names a tool no member has');", 1, 0, 'void q;', SERVER],
  ['M23', 'the request body limit is lifted', ROUTES, "express.json({ limit: '64kb' })", 1, 0, "express.json({ limit: '64mb' })", SERVER],
  ['M24', 'a rejected tool name is echoed in the error', ROUTES, "throw new ConfigError('tool', 'is not a well-formed tool name');", 1, 0, "throw new ConfigError('tool', String(req.body.tool));", SERVER],
  ['M25', 'the scan notes stop saying the scan covers only that caller', ROUTES, 'This scan covers only the', 1, 0, 'This scan reads the', SERVER],
  ['M26', 'the filtered-listing limit is dropped from every report', 'server/src/scanner/rules.js', "{ id: 'filtered-listing',", 1, 0, "{ id: 'filtered-unused',", SERVER],
  ['M27', 'a gateway route makes an outbound request', ROUTES, "res.json({ claim: CLAIM, view: p.view, caller: p.caller.id, ...listing(p) });", 1, 0, "fetch('http://192.0.2.1:4769/').catch(() => {}); res.json({ claim: CLAIM, view: p.view, caller: p.caller.id, ...listing(p) });", SERVER],
  ['M28', 'a swagger-tagged name is retagged as a deck claim (provenance)', 'server/src/gateway/provenance.js', "{ name: 'ToolFilter', tag: 'swagger'", 1, 0, "{ name: 'ToolFilter', tag: 'deck'", SERVER],
  ['M29', 'the aggregate policy cap is tagged as a swagger name (invented field)', 'server/src/gateway/provenance.js', "{ name: 'aggregate policy cap', tag: 'deck'", 1, 0, "{ name: 'aggregate policy cap', tag: 'swagger'", SERVER],
  ['W01', 'the banner is removed from every tab', 'web/src/App.jsx', '      <ReleaseBanner config={config} />\n', 1, 0, '', WEB(GW_PAGE)],
  ['W02', 'the banner disappears in presenter mode', 'web/src/components/ReleaseBanner.jsx', 'export default function ReleaseBanner({ config }) {', 1, 0, 'export default function ReleaseBanner({ config }) {\n  if (document.documentElement.dataset.present === "1") return null;', WEB(GW_PAGE)],
  ['W03', 'Reset no longer restores the gateway state', 'web/src/lib/gateway.js', 'reset: load,', 1, 0, 'reset: () => {},', WEB(GW_PAGE)],
  ['W04', 'the diagram Reset no longer resets the gateway state', 'web/src/pages/Diagram.jsx', ' gw?.reset?.(); };', 1, 0, ' };', WEB(GW_PAGE)],
  ['W05', 'editing a cap box has no effect', 'web/src/lib/gateway.js', 'export const toggleCap = (config, caller, name, on) => ({ ...config, cap: toggleGrant(config.cap, caller, name, on) });', 1, 0, 'export const toggleCap = (config) => config;', WEB(GW_PAGE)],
  ['W06', 'the scan result is not shown', 'web/src/pages/Gateway.jsx', '            <ScanResult report={state.scan.report} />\n', 1, 0, '', WEB(GW_PAGE)],
  ['W07', 'the demo audit loses its "not what the caller sees" label', 'web/src/pages/Gateway.jsx', '<strong>Not what the caller sees.</strong>', 1, 0, '<strong>Audit.</strong>', WEB(GW_PAGE)],
  ['W08', 'the provenance table shows no tag text', 'web/src/pages/Gateway.jsx', '{state.tags?.[p.tag] ?? p.tag}', 1, 0, '{p.note}', WEB(GW_PAGE)],
  ['W09', 'renaming an alias does not carry the cap', 'web/src/lib/gateway.js', "const cap = config.cap.map((g) => ({ ...g, tools: g.tools.map((t) => (t.startsWith(`${m.alias}__`) ? `${alias}__${t.slice(m.alias.length + 2)}` : t)) }));", 1, 0, 'const cap = config.cap;', WEB(GW_LIB)],
  ['W10', 'the ToolFilter box edits nothing', 'web/src/lib/gateway.js', 'return setMember(config, id, { toolFilter: on ?', 1, 0, 'return setMember(config, id, { toolFilterX: on ?', WEB(GW_LIB)],
  ['W11', 'the signed-in (linkedCallers) box edits nothing', 'web/src/lib/gateway.js', 'return setMember(config, id, { linkedCallers: on ?', 1, 0, 'return setMember(config, id, { linkedX: on ?', WEB(GW_LIB)],
  ['W12', 'the member policy box edits nothing', 'web/src/lib/gateway.js', 'return setMember(config, id, { policy: toggleGrant(m.policy, caller, tool, on) });', 1, 0, 'return setMember(config, id, { policyX: toggleGrant(m.policy, caller, tool, on) });', WEB(GW_LIB)],
  ['W13', 'the Reachable box edits nothing', 'web/src/pages/Gateway.jsx', 'edit(setMember(config, m.id, { reachable: on }))', 1, 0, 'edit(setMember(config, m.id, { reachableX: on }))', WEB(GW_PAGE)],
  ['W14', 'the alias box edits nothing', 'web/src/pages/Gateway.jsx', 'onCommit={(a) => edit(renameAlias(config, m.id, a))}', 1, 0, 'onCommit={() => {}}', WEB(GW_PAGE)],
  ['W15', 'the per-user upstream box edits nothing', 'web/src/pages/Gateway.jsx', 'edit(setMember(config, m.id, { upstream: on ? "per-user" : "none" }))', 1, 0, 'edit(setMember(config, m.id, { upstreamX: on ? "per-user" : "none" }))', WEB(GW_PAGE)],
];

const only = process.argv.slice(2);
const chosen = MUTANTS.filter((m) => !only.length || only.includes(m[0]));
const originals = new Map();
const restore = () => { for (const [file, text] of originals) fs.writeFileSync(path.join(ROOT, file), text); originals.clear(); };
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('exit', restore);

function apply([id, , file, find, count, nth, replace]) {
  const abs = path.join(ROOT, file);
  const text = fs.readFileSync(abs, 'utf8');
  const at = [];
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + 1)) at.push(i);
  if (at.length !== count) throw new Error(`${id}: expected ${count} occurrence(s) of the text in ${file}, found ${at.length}`);
  originals.set(file, text);
  fs.writeFileSync(abs, text.slice(0, at[nth]) + replace + text.slice(at[nth] + find.length));
}

const env = { ...process.env, STANDALONE_ENV: process.env.STANDALONE_ENV || '/nonexistent/none.env' };
function run(runner) {
  for (const [name, nodeArgs, cmd] of runner.steps) {
    const r = cmd ? spawnSync(cmd[0], cmd.slice(1), { cwd: runner.cwd, env, encoding: 'utf8', timeout: 300_000 }) : spawnSync(process.execPath, nodeArgs, { cwd: runner.cwd, env, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) {
      // For the report only (the verdict is the exit code): the first failing test's title.
      const out = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
      const title = out.find((l) => /^\s*(✖|×)\s/.test(l)) || out.find((l) => /FAIL /.test(l)) || '(a suite failed to run)';
      return { killed: true, by: name, title: title.trim().replace(/\s+\(\d+(\.\d+)?ms\)$/, '').slice(0, 200) };
    }
  }
  return { killed: false };
}

const survived = [];
for (const m of chosen) {
  const [id, what] = m;
  try {
    apply(m);
    const r = run(m[7]);
    console.log(`${r.killed ? 'KILLED  ' : 'SURVIVED'} ${id} ${what}${r.killed ? `\n           by ${r.by}: ${r.title}` : ''}`);
    if (!r.killed) survived.push(id);
  } finally { restore(); }
}
console.log(`\n${chosen.length - survived.length} of ${chosen.length} mutants killed${survived.length ? `; SURVIVED: ${survived.join(', ')}` : ''}`);
process.exit(survived.length ? 1 : 0);
