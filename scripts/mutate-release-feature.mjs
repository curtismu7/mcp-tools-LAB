#!/usr/bin/env node
// Mutation check for the entitled-listing feature (Ping release claim of 2026-11-02 (listing and cap measured on gateway v1.261106; per-caller entitlement UNVERIFIED on our tenant)).
// For each mutant it changes ONE thing in a source file, runs the tests that should notice, and expects them to FAIL.
// A mutant that passes the tests "survived" and the script exits 1. The file is always put back, even on Ctrl-C.
// Every mutant names the exact text it replaces and how many times that text occurs, so a mutant can never silently
// do nothing (a wrong count is an error, not a pass).
//
//   node scripts/mutate-release-feature.mjs            all mutants, one at a time (about twenty minutes)
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
    ['credentials', ['--test', '--test-timeout=120000', 'test/gateway.credentials.test.js']],
  ],
};
// Faster runners for mutants that only the config or credential tests can notice (the first failing step ends the run).
const CFG = { cwd: path.join(ROOT, 'server'), steps: [['config', ['--test', '--test-timeout=60000', 'test/gateway.config.test.js']], ['api', ['--test', '--test-timeout=60000', 'test/gateway.api.test.js']]] };
const CREDS = { cwd: path.join(ROOT, 'server'), steps: [['credentials', ['--test', '--test-timeout=120000', 'test/gateway.credentials.test.js']]] };
const API = { cwd: path.join(ROOT, 'server'), steps: [['api', ['--test', '--test-timeout=60000', 'test/gateway.api.test.js']]] };
const LABELS = (file) => ({ cwd: path.join(ROOT, 'web'), steps: [['labels', null, ['npx', 'vitest', 'run', file]]] });
// The real browser: build the mutated page into a temp folder (web/dist is never touched), then drag every box.
const BROWSER = { cwd: ROOT, steps: [['browser', null, ['sh', '-c', 'd=$(mktemp -d) && (cd web && npx vite build --outDir "$d" --emptyOutDir >/dev/null 2>&1) && WEB_DIST="$d" node scripts/diagram-drag-check.mjs; s=$?; rm -rf "$d"; exit $s']]] };
const WEB = (file) => ({ cwd: path.join(ROOT, 'web'), steps: [['web', null, ['npx', 'vitest', 'run', file]]] });
const GW_PAGE = 'src/pages/__tests__/gateway.test.jsx';
const GW_LIB = 'src/lib/__tests__/gateway.test.js';
const SIM = 'server/src/gateway/sim.js';
const CONFIG = 'server/src/gateway/config.js';
const ROUTES = 'server/src/gateway/routes.js';

// A credential rule is one line of the CREDENTIAL list in config.js: ['name', /regex/]. These helpers read the line from the
// source, so a mutant never repeats a regex by hand.
const CONFIG_TEXT = fs.readFileSync(path.join(ROOT, CONFIG), 'utf8');
const ruleLine = (name) => {
  const line = CONFIG_TEXT.split('\n').find((l) => l.startsWith(`  ['${name}', `));
  if (!line) throw new Error(`no credential rule named ${name}`);
  return `${line}\n`;
};
const dropRule = (id, name, what) => [id, what, CONFIG, ruleLine(name), 1, 0, '', CREDS];
const inRule = (id, name, what, from, to) => {
  const line = ruleLine(name);
  if (!line.includes(from)) throw new Error(`${id}: ${from} is not in the ${name} rule`);
  return [id, what, CONFIG, line, 1, 0, line.replace(from, () => to), CREDS];
};
const swap = (id, what, file, from, to, runner, count = 1) => [id, what, file, from, count, 0, to, runner];

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
  ['M18', 'a typed credential is no longer refused', CONFIG, 'export const credentialLike = (s) => credentialRules(s).length > 0;', 1, 0, 'export const credentialLike = () => false;', SERVER],
  ['M19', 'unknown config fields are accepted', CONFIG, "if (!allowed.includes(k)) throw new ConfigError(where, 'unexpected field');", 1, 0, 'void k;', SERVER],
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
  // Credential detection, one rule or one place at a time (added in the fix pass after three extra mutants survived).
  dropRule('C01', 'bearer', 'the Bearer rule is removed from the credential check'),
  dropRule('C02', 'key-prefix', 'the key-prefix rule is removed from the credential check'),
  dropRule('C03', 'akia', 'the AKIA rule is removed from the credential check'),
  dropRule('C04', 'mixed-token', 'the long mixed-case token rule is removed from the credential check'),
  dropRule('C05', 'jwt', 'the JWT rule is removed from the credential check'),
  dropRule('C18', 'hex', 'the lower-case hex rule is removed from the credential check'),
  dropRule('C19', 'basic', 'the Basic-auth rule is removed from the credential check'),
  dropRule('C20', 'assignment', 'the password= / secret= / api_key= rule is removed from the credential check'),
  inRule('C21', 'key-prefix', 'the key-prefix rule starts with a word boundary again (x_sk-... and tok_ghp_... slip through)', '(?<![A-Za-z0-9])', '\\b'),
  inRule('C22', 'key-prefix', 'the ghp prefix is dropped', 'ghp|', ''),
  inRule('C23', 'key-prefix', 'the xox (Slack) prefixes are dropped', '|xox[abprs]', ''),
  inRule('C24', 'key-prefix', 'the underscore separator is dropped (sk_live_...)', '[-_]', '-'),
  inRule('C25', 'key-prefix', 'the key-prefix minimum length drops to 1', '{12,}', '{1,}'),
  inRule('C26', 'bearer', 'the Bearer rule becomes case-sensitive', '/i]', '/]'),
  inRule('C27', 'bearer', 'Bearer glued with an underscore is no longer matched', '[\\s_]+', '\\s+'),
  inRule('C28', 'bearer', 'the Bearer minimum length drops to 1', '{8,}', '{1,}'),
  inRule('C29', 'jwt', 'a JWT with an empty signature is no longer matched', '(?:\\.[A-Za-z0-9_-]*)?', '\\.[A-Za-z0-9_-]+'),
  inRule('C30', 'akia', 'the AKIA rule loses its trailing boundary', '(?![A-Za-z0-9])', ''),
  inRule('C31', 'hex', 'the hex rule needs 33 characters', '{32,}', '{33,}'),
  inRule('C32', 'basic', 'the Basic rule loses its padding branch', '|[A-Za-z0-9+/]{12,}={1,2}', ''),
  inRule('C33', 'basic', 'the Basic rule matches plain words such as "Basic Authentication"', '(?=[A-Za-z0-9+/]*(?:[0-9+/]|[a-z][A-Z]))', ''),
  inRule('C34', 'assignment', 'the api_key assignment is dropped', '|api[-_]?key', ''),
  inRule('C35', 'assignment', 'the secret assignment is dropped', '|secret', ''),
  inRule('C36', 'assignment', 'the assignment value minimum drops to 1', '{4,}', '{1,}'),
  swap('C37', 'the text is not normalised with NFKC before the credential test', CONFIG, "const clean = (s) => s.normalize('NFKC').replace(/\\p{Cf}/gu, '');", "const clean = (s) => s.replace(/\\p{Cf}/gu, '');", CREDS),
  swap('C38', 'invisible format characters are not stripped before the credential test', CONFIG, "const clean = (s) => s.normalize('NFKC').replace(/\\p{Cf}/gu, '');", "const clean = (s) => s.normalize('NFKC');", CREDS),
  ['C06', 'names (tool, member, alias, caller id) are no longer checked for a credential', CONFIG, 're.test(n) && !credentialLike(n);', 1, 0, 're.test(n);', SERVER],
  ['C07', 'descriptions and labels are no longer checked for a credential', CONFIG, "  if (credentialLike(v)) throw new ConfigError(where, 'looks like a credential; this lab takes none');\n  return v;", 1, 0, '  return v;', SERVER],
  ['C08', 'call arguments are no longer checked for a credential', ROUTES, ' || argsLookLikeCredentials(req.body.arguments)', 1, 0, '', SERVER],
  ['C09', 'the inputSchema is not checked for a credential at all', CONFIG, "      if (t.inputSchema !== undefined) schemaText(t.inputSchema, `${tt}.inputSchema`);\n", 1, 0, '', SERVER],
  ['C10', 'inputSchema keys are not checked for a credential', CONFIG, "        if (credentialLike(k)) throw new ConfigError(where, 'looks like a credential; this lab takes none');\n", 1, 0, '', SERVER],
  ['C11', 'inputSchema string values are not checked for a credential', CONFIG, "      if (credentialLike(v)) throw new ConfigError(where, 'looks like a credential; this lab takes none');\n    } else if (Array.isArray(v)) {", 1, 0, '    } else if (Array.isArray(v)) {', SERVER],
  ['C12', 'inputSchema list items are not walked', CONFIG, '      for (const x of v) walk(x, depth + 1);', 1, 0, '      void v;', SERVER],
  ['C13', 'inputSchema object values are not walked', CONFIG, '        walk(x, depth + 1);\n      }', 1, 0, '        void x;\n      }', SERVER],
  ['C14', 'the inputSchema depth bound is lifted', CONFIG, 'nodes > BOUNDS.schemaNodes || depth > BOUNDS.schemaDepth', 1, 0, 'nodes > BOUNDS.schemaNodes', SERVER],
  ['C15', 'the inputSchema value-count bound is lifted', CONFIG, 'nodes > BOUNDS.schemaNodes || depth > BOUNDS.schemaDepth', 1, 0, 'depth > BOUNDS.schemaDepth', SERVER],
  ['C16', 'the inputSchema string-length bound is lifted', CONFIG, 'if (v.length > BOUNDS.schemaText)', 1, 0, 'if (false)', SERVER],
  ['C17', 'the inputSchema key-length bound is lifted', CONFIG, 'if (k.length > BOUNDS.schemaKey)', 1, 0, 'if (false)', SERVER],
  // Validation guards, one change each (added in the fix pass: every limit and every refusal has a test that names it).
  swap('K01', 'a duplicate tool name is accepted', CONFIG, "if (!nameOk(t.name, TOOL_NAME) || toolNames.has(t.name))", 'if (!nameOk(t.name, TOOL_NAME))', CFG),
  swap('K02', 'a duplicate caller id is accepted', CONFIG, "if (callerIds.has(c.id)) throw new ConfigError(`${at}.id`, 'is a duplicate');", 'void callerIds;', CFG),
  swap('K03', 'a duplicate member id is accepted', CONFIG, 'if (!nameOk(m.id, ID) || memberIds.has(m.id))', 'if (!nameOk(m.id, ID))', CFG),
  swap('K04', 'a duplicate inside a name list is accepted', CONFIG, "if (out.has(n)) throw new ConfigError(where, 'has a duplicate');", 'void out;', CFG),
  swap('K05', 'an alias may hold an underscore', CONFIG, 'const ALIAS = /^[a-z][a-z0-9-]{0,15}$/;', 'const ALIAS = /^[a-z][a-z0-9_-]{0,15}$/;', CFG),
  swap('K06', 'a caller may appear twice in a grant list', CONFIG, "if (out.has(g.caller)) throw new ConfigError(at, 'caller appears twice');", 'void out;', CFG),
  swap('K07', 'a config with no callers is accepted', CONFIG, "if (!callers.length) throw new ConfigError('callers', 'needs at least one caller');", 'void callers;', CFG),
  swap('K08', 'a config with no members is accepted', CONFIG, "if (!members.length) throw new ConfigError('members', 'needs at least one member');", 'void members;', CFG),
  swap('K09', 'an unknown top-level config field is accepted', CONFIG, "only(raw, ['schema', 'callers', 'members', 'cap'], 'config');\n", '', CFG),
  swap('K10', 'an unknown caller field is accepted', CONFIG, "    only(c, ['id', 'label'], at);\n", '', CFG),
  swap('K11', 'an unknown member field is accepted', CONFIG, "    only(m, ['id', 'alias', 'reachable', 'upstream', 'linkedCallers', 'toolFilter', 'tools', 'policy'], at);\n", '', CFG),
  swap('K12', 'an unknown tool field is accepted', CONFIG, "      only(t, ['name', 'description', 'inputSchema'], tt);\n", '', CFG),
  swap('K13', 'an unknown grant field is accepted', CONFIG, "    only(g, ['caller', 'tools'], at);\n", '', CFG),
  swap('K14', 'the callers bound is 9', CONFIG, 'callers: 8,', 'callers: 9,', CFG),
  swap('K15', 'the members bound is 7', CONFIG, 'members: 6,', 'members: 7,', CFG),
  swap('K16', 'the tools-per-member bound is 41', CONFIG, 'tools: 40,', 'tools: 41,', CFG),
  swap('K17', 'the name-list bound is 401', CONFIG, 'listed: 400,', 'listed: 401,', CFG),
  swap('K18', 'the inputSchema value-count bound is 401', CONFIG, 'schemaNodes: 400,', 'schemaNodes: 401,', CFG),
  swap('K19', 'the inputSchema depth bound is 9', CONFIG, 'schemaDepth: 8,', 'schemaDepth: 9,', CFG),
  swap('K20', 'the inputSchema string bound is 1001', CONFIG, 'schemaText: 1000,', 'schemaText: 1001,', CFG),
  swap('K21', 'the inputSchema key bound is 101', CONFIG, 'schemaKey: 100 }', 'schemaKey: 101 }', CFG),
  swap('K22', 'the caller label cap is 41', CONFIG, 'text(c.label, `${at}.label`, 40)', 'text(c.label, `${at}.label`, 41)', CFG),
  swap('K23', 'the description cap is 1001', CONFIG, "`${tt}.description`, 1000)", "`${tt}.description`, 1001)", CFG),
  swap('K24', 'the inputSchema JSON size cap is 4001', CONFIG, '.length > 4000)', '.length > 4001)', CFG),
  swap('K25', 'the id length cap is 25', CONFIG, 'const ID = /^[a-z][a-z0-9-]{0,23}$/;', 'const ID = /^[a-z][a-z0-9-]{0,24}$/;', CFG),
  swap('K26', 'the alias length cap is 17', CONFIG, 'const ALIAS = /^[a-z][a-z0-9-]{0,15}$/;', 'const ALIAS = /^[a-z][a-z0-9-]{0,16}$/;', CFG),
  swap('K27', 'the tool name length cap is 65', CONFIG, 'export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;', 'export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,64}$/;', CFG),
  swap('K28', 'the inputSchema JSON size cap is removed', CONFIG, "if (t.inputSchema !== undefined && JSON.stringify(t.inputSchema).length > 4000) throw new ConfigError(`${tt}.inputSchema`, 'is too large');", 'void tt;', CFG),
  swap('R01', 'the call-argument value budget is 201', ROUTES, 'budget = { n: 200 }', 'budget = { n: 201 }', API),
  swap('R02', 'the call-argument budget is off by one', ROUTES, 'budget.n-- <= 0', 'budget.n-- < 0', API),
  swap('R03', 'the call-argument depth bound is 5', ROUTES, 'depth > 4', 'depth > 5', API),
  swap('R04', 'the call-argument string bound is 2001', ROUTES, 'v.length > 2000', 'v.length > 2001', API),
  swap('R05', 'the call-argument key bound is 101', ROUTES, 'k.length > 100', 'k.length > 101', API),
  swap('R06', 'an unknown tool in the direct view gets a different refusal body', SIM, "if (!t) return refused([{ stage: 'member', layer: 'unknown', decision: 'refused' }]);", "if (!t) return { ok: false, error: 'unknown_tool', message: 'No such tool on this member.', trace: [{ stage: 'member', layer: 'unknown', decision: 'refused' }] };", API),
  swap('R07', 'an unknown tool through the aggregate gets a different refusal body', SIM, "if (!hit) return refused([{ stage: 'entry', layer: 'unknown', decision: 'refused' }]);", "if (!hit) return { ok: false, error: 'unknown_tool', message: REFUSAL, trace: [{ stage: 'entry', layer: 'unknown', decision: 'refused' }] };", API),
  // Diagram edge labels: the geometry in a unit test, the wiring in the real browser.
  swap('L01', 'labels are not moved off the boxes by default', 'web/src/lib/labelSpot.js', 'avoid = true)', 'avoid = false)', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('L02', 'a label stays on the middle of its edge even when a box is there', 'web/src/lib/labelSpot.js', 'if (free(mid.x, mid.y)) return mid;', 'return mid;', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('L03', 'a label does not avoid the labels placed before it', 'web/src/lib/labelSpot.js', '[...nodes, ...placed]', '[...nodes]', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('L04', 'a label keeps no air around it', 'web/src/lib/labelSpot.js', 'const MARGIN = 4;', 'const MARGIN = 0;', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('L05', 'the search for a clear spot gives up too soon', 'web/src/lib/labelSpot.js', 'const REACH = 150;', 'const REACH = 100;', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('L06', 'a tie between above and below goes below', 'web/src/lib/labelSpot.js', '(dy > 0 ? 0.5 : 0)', '(dy > 0 ? -0.5 : 0)', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('L07', 'a label is not as wide as its text', 'web/src/lib/labelSpot.js', 'String(text ?? "").length * 7 + 14', 'String(text ?? "").length * 1 + 2', LABELS('src/lib/__tests__/labelSpot.test.js')),
  swap('B01', 'the diagram edges stop using the clear-label edge type', 'web/src/pages/Diagram.jsx', 'type: "clear", ', '', BROWSER),
  swap('B02', 'the clear-label edge ignores the spot it computed', 'web/src/pages/Diagram.jsx', 'labelX={spot?.x ?? midX} labelY={spot?.y ?? midY}', 'labelX={midX} labelY={midY}', BROWSER),
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
