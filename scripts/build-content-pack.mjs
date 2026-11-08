#!/usr/bin/env node
/**
 * Generates content-pack.json (repo root). Format: docs/content-pack.schema.json (a copy of the ID-JAG kit's schema).
 * Glossary from content/terms.json; the two stories from web/src/data/stories. Deterministic: lists sorted by id, 2-space
 * JSON, no timestamps. The git commit is recorded only when passed (--commit=<sha>).
 * Pattern from hostile-mcp scripts/build-content-pack.mjs (same author).
 *
 * Story ids: the schema requires S<2 digits>; the in-app stories are MT1, MT2 and MT3, published here as S01, S02 and S03.
 * Sources: one. The only public documentation URL in the source READMEs is the MCP home page, named in the inspector's
 * README. It was not fetched while writing this pack, so its status is "not-read".
 *
 *   node scripts/build-content-pack.mjs [--commit=<sha>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_PATH = path.join(ROOT, 'content-pack.json');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// In-app story id -> pack story id.
const STORY_IDS = { MT1: 'S01', MT2: 'S02', MT3: 'S03' };

const CARDS = [
  { id: 'connect', label: 'Connect to a server', description: 'Add an MCP server over HTTP or stdio. Connecting sends only an initialize request.', group: 'setup', href: '/#connect', terms: ['inspector'] },
  { id: 'server', label: 'List, scan, then call', description: 'See the tools, press Scan, read the findings with evidence, and only then call a tool behind the confirm step.', group: 'try-it', href: '/#server', terms: ['tool-metadata', 'hidden-instruction', 'exfil-sink', 'name-shadowing', 'confirm-gate'] },
  { id: 'live-proxy', label: 'Watch an agent through the live proxy', description: 'Point Claude Code or another MCP client at this tool and see every JSON-RPC message, with timing and an estimated token cost. A local passthrough, not a gateway: the confirm step does not cover the agent\'s calls.', group: 'try-it', href: '/#proxy', terms: ['live-proxy', 'token-estimate'] },
  { id: 'review-brief', label: 'Flag items and hand over a review brief', description: 'Flag tools, resources or prompts with a note and download a Markdown brief for a coding agent, with server text fenced as untrusted data.', group: 'try-it', href: '/#server', terms: ['review-brief', 'tool-poisoning'] },
  { id: 'offline', label: 'Scan a snapshot offline', description: 'Paste or load a tools/list JSON and scan it with no server. Invisible characters are shown as [U+XXXX].', group: 'try-it', href: '/#offline', terms: ['bidi-zero-width', 'scan-report'] },
  { id: 'story-scan-first', label: 'Story: scan before you trust', description: 'Look at what the server says about itself before your agent does.', group: 'concept', href: '/#stories', terms: ['tool-poisoning', 'hidden-instruction', 'trust-on-first-use'], story: 'S01' },
  { id: 'story-looked-clean', label: 'Story: it looked clean, then changed', description: 'A clean scan is a statement about one list, not about the server.', group: 'concept', href: '/#stories', terms: ['trust-on-first-use', 'tool-poisoning'], story: 'S02' },
  { id: 'entitled-listing', label: 'Entitled listing and aggregate cap (Ping release claim)', description: 'A simulation of a Ping release claim (2026-11-02), listing and cap measured on gateway v1.261106 (2026-11-08), per-caller entitlement UNVERIFIED on our tenant: tools a caller may not use are removed from the list and refused by name, and an aggregate policy cap is enforced twice. Edit the policy and watch the lists change.', group: 'try-it', href: '/#gateway', terms: ['entitlement-aware-discovery', 'aggregate-policy-cap', 'mcp-aggregate', 'tool-filter', 'filtered-listing-scan'] },
  { id: 'story-entitled-listing', label: 'Story: only what you may see', description: 'Same server, different callers: what each is shown, what is refused by name, what the cap removes, and what a scan of a filtered list cannot say.', group: 'concept', href: '/#stories', terms: ['entitlement-aware-discovery', 'aggregate-policy-cap', 'filtered-listing-scan'], story: 'S03' },
  { id: 'why-it-matters-gateway', label: 'Why it matters: MCP gateway and aggregate (Ping claims)', description: 'The Challenge, Technical and Business lines from Ping\'s H2 2026 deck, slides 36 and 37, labelled as Ping claims, UNVERIFIED on our tenant.', group: 'reference', href: '/#stories', terms: ['why-mcp-gateway', 'why-mcp-aggregate'] },
  { id: 'diagram', label: 'How it fits', description: 'Server, inspector, scanner, operator and the call path, plus the entitled-listing run. Movable boxes, Simulate, Reset.', group: 'concept', href: '/#diagram', terms: ['inspector'] },
  { id: 'limits', label: 'What a scan cannot catch', description: 'Result injection, rug-pulls after the scan, unfetched content and novel phrasing.', group: 'reference', href: '/#limits', terms: ['trust-on-first-use', 'scan-report'] },
];

export function buildPack({ commit } = {}) {
  const pkg = readJson('package.json');
  const stories = fs.readdirSync(path.join(ROOT, 'web/src/data/stories')).filter((f) => f.endsWith('.json')).map((f) => ({ f, s: readJson(`web/src/data/stories/${f}`) }))
    .map(({ f, s }) => {
      if (!STORY_IDS[s.id]) throw new Error(`story ${s.id} has no pack id in STORY_IDS`);
      return { id: STORY_IDS[s.id], title: s.title.replace(/\{\{[^}]+\}\}/g, (m) => ({ '{{ada}}': 'An operator', '{{vocab.server}}': 'a server', '{{vocab.serverShort}}': 'The server' }[m] || 'the')), say: s.say, file: `web/src/data/stories/${f}` };
    }).sort(byId);
  const ids = new Set(stories.map((s) => s.id));
  const pack = {
    schema: 'demo-content-pack/1',
    id: 'mcp-tools',
    title: 'MCP tools: inspector and scanner',
    version: pkg.version,
    ...(commit ? { source: { repo: 'mcp-tools', commit } } : {}),
    demo: { id: 'mcp-tools', name: 'MCP tools', catalog: 'D3', baseUrl: 'http://localhost:4810', doctor: '/api/health', tags: ['mcp', 'inspector', 'scanner', 'tool-poisoning', 'mcp-aggregate', 'entitlement'] },
    glossary: readJson('content/terms.json').sort(byId),
    sources: [{ id: 'mcp-home', title: 'Model Context Protocol', url: 'https://modelcontextprotocol.io', kind: 'website', use: 'Named as the MCP home page in the inspector README this repo was copied from. Not quoted here.', status: 'not-read', checked: '2026-10-21' }],
    cards: CARDS.map(({ href, ...c }) => ({ ...c, action: { type: 'route', href } })).sort(byId),
    diagrams: [{ id: 'fit', label: 'How the inspector, scanner and operator fit', href: '/#diagram' }, { id: 'fit-entitled-listing', label: 'Entitled listing and aggregate cap (Ping release claim, simulated)', href: '/#diagram', mode: 'gateway' }],
    stories,
  };
  for (const c of pack.cards) if (c.story && !ids.has(c.story)) throw new Error(`card ${c.id} names unknown story ${c.story}`);
  return pack;
}

export const serialize = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice(9);
  fs.writeFileSync(PACK_PATH, serialize(buildPack({ commit })));
  console.log(`wrote ${path.relative(process.cwd(), PACK_PATH) || PACK_PATH}`);
}
