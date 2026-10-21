#!/usr/bin/env node
// Generates docs/scan-rules.md from the rule table (server/src/scanner/rules.js) plus the "what it misses" notes below.
// Deterministic. The test fails if the committed file is stale or a rule has no note.
//   node scripts/build-scan-rules.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, RULES } from '../server/src/scanner/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_PATH = path.join(ROOT, 'docs', 'scan-rules.md');

// Per rule: where it looks, and what slips past it. Written against server/src/scanner/engine.js and unicode.js.
const NOTES = {
  'MT-HI-001': { where: 'tool descriptions, argument descriptions, resource and prompt text, card text', misses: 'Other tag names, tags written with look-alike letters, instructions with no tag at all.' },
  'MT-HI-002': { where: 'same as MT-HI-001', misses: '"do not tell/mention/inform/reveal/disclose/notify" only, English only. "Keep this between us" or the same sentence in another language is not matched.' },
  'MT-HI-003': { where: 'same as MT-HI-001', misses: 'A fixed list of phrases ("ignore previous", "before calling any tool", "you must always/first", "always call"). A reworded imperative passes.' },
  'MT-EX-001': { where: 'values under default, const, enum and examples in an input schema', misses: 'A destination built at call time, a non-URL sink (a file path, a DNS name without a scheme), an off-box URL in the description text rather than a default. Loopback and localhost are treated as on-box.' },
  'MT-EX-002': { where: 'argument descriptions and A2A skill descriptions', misses: 'Words outside the list (credentials, tokens, secrets, passwords, API keys, full context). It also fires on honest text such as "do not send a password here"; read the evidence.' },
  'MT-CR-001': { where: 'tool descriptions', misses: 'Verb plus secret within 60 characters on one line, English only. A schema that simply asks for a password without the description saying so is MT-CR-002 only.' },
  'MT-CR-002': { where: 'input-schema property names', misses: 'Names not in the list (a password called "pw" or "k"); it also flags a legitimate login tool.' },
  'MT-SH-001': { where: 'tool names, against the trusted-names list you supply', misses: 'Nothing without a trusted list: with none, shadowing against other servers cannot be judged.' },
  'MT-SH-002': { where: 'tool names, against the trusted-names list', misses: 'Look-alikes beyond case, separators, accents and a short table of Cyrillic and Greek letters; a one-letter typo is not matched.' },
  'MT-SH-003': { where: 'tool descriptions', misses: 'Two phrase shapes only ("authoritative ... tool", "ignore any/all other ... tools"). Other ways to claim priority pass.' },
  'MT-SH-004': { where: 'one tools/list result', misses: 'Duplicates across two servers or across two lists (use the trusted list and pinning for that).' },
  'MT-SA-001': { where: 'resource and prompt text (not tool descriptions)', misses: 'Fires on any mention of transfer, payment, payout, wire or remit, so a banking prompt trips it; and it misses a money-moving instruction in a tool description.' },
  'MT-SA-002': { where: 'resource and prompt text', misses: 'Bypass wording within 40 characters of approval, consent or authorization; other phrasings and other languages pass.' },
  'MT-UC-001': { where: 'every string, including argument names', misses: 'Only the listed bidirectional marks, embeddings and isolates are matched. It cannot tell legitimate right-to-left text from an attack, so Arabic or Hebrew text that carries explicit marks is flagged.' },
  'MT-UC-002': { where: 'every string, including argument names', misses: 'Invisible characters outside the listed set. A zero-width joiner is reported only between two ASCII characters, so emoji sequences are not flagged.' },
  'MT-UC-003': { where: 'every string', misses: 'Only the tag block U+E0000 to U+E007F. Other ways to hide text (a homoglyph, a zero-width encoding) are separate rules. The hidden ASCII is decoded into the detail when it is printable.' },
  'MT-UC-004': { where: 'every string', misses: 'Words made wholly of look-alike letters (all Cyrillic) are not mixed-script; other scripts are not checked; a legitimate mixed word such as a product name trips it.' },
  'MT-DS-001': { where: 'tool descriptions', misses: 'Length only (over 2000 characters). It says nothing about content; long text is where a payload can be buried.' },
  'MT-LM-001': { where: 'the whole input', misses: 'It is the scan saying what it did not read: over the depth, value, character or finding budget, or a cycle. The unread part is not judged at all.' },
};

export function buildScanRules() {
  const ids = Object.keys(RULES);
  for (const id of ids) if (!NOTES[id]) throw new Error(`rule ${id} has no note in scripts/build-scan-rules.mjs`);
  for (const id of Object.keys(NOTES)) if (!RULES[id]) throw new Error(`note for unknown rule ${id}`);
  const esc = (s) => s.replace(/\|/g, '\\|');
  const rows = ids.sort().map((id) => `| ${id} | ${RULES[id].severity} | ${RULES[id].kind} | ${esc(RULES[id].title)} | ${esc(NOTES[id].where)} | ${esc(NOTES[id].misses)} |`);
  return [
    '# Scan rules',
    '',
    '<!-- Generated by `node scripts/build-scan-rules.mjs` from server/src/scanner/rules.js. Do not edit by hand; a test fails if it is stale. -->',
    '',
    'The scanner **reports; it never blocks**, never calls a tool and never changes a server\'s data. Every rule is a heuristic over metadata. Ids never change meaning and each has one fixed severity (`info`, `warn`, `high`). Evidence for every finding is the field path, the character span and an excerpt with invisible characters shown as `[U+XXXX]`.',
    '',
    '| Id | Severity | Kind | What it catches | Where it looks | What it misses |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## What a metadata scan does not catch at all',
    '',
    ...LIMITS.map((l) => `- ${l.text}`),
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(DOC_PATH, buildScanRules());
  console.log(`wrote ${path.relative(process.cwd(), DOC_PATH)}`);
}
