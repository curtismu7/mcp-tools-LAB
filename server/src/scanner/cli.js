// CLI: scan tool/agent metadata for poison before an agent would ingest it. Adapted from AI-DEMO2
// standalone/mcp-scanner/index.mjs (MIT). It reports; it never blocks or changes anything on the server.
//
//   npm run scan -- <mcp-url | snapshot.json> [options]
//   npm run scan -- --card <agent-card-url | card.json>
//
//   --json               print the scan-report/1 document instead of text
//   --trusted a,b        tool names you already trust (from other servers); same-name tools are flagged as shadowing
//   --trusted-file f     the same, one name per line
//   --fail-on LEVEL      exit 1 when a finding is at or above info|warn|high (default warn); "none" never fails
//   --no-fetch           do not read resource/prompt content (list only)
// Auth for a URL: set MCPTOOLS_SCAN_AUTHORIZATION to the full Authorization header value (kept out of argv and logs).
// Exit codes: 0 clean, 1 findings at or above --fail-on, 2 could not read the input.
import fs from 'node:fs';
import { createHttpClient } from '../mcp/http.js';
import { analyze, buildReport, LIMITS, parseSnapshot, severityRank } from './index.js';
import { collectFromClient } from './live.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name) => { const i = args.indexOf(name); if (i === -1) return false; args.splice(i, 1); return true; };

const asJson = bool('--json');
const noFetch = bool('--no-fetch');
const cardTarget = flag('--card');
const failOn = flag('--fail-on') || 'warn';
const trusted = [...String(flag('--trusted') || '').split(','), ...(flagFile(flag('--trusted-file')))].map((s) => s.trim()).filter(Boolean);
const target = cardTarget ?? args[0] ?? process.env.MCP_URL;

function flagFile(f) { return f ? fs.readFileSync(f, 'utf8').split('\n') : []; }
function die(msg) { console.error(`[scanner] ${msg}`); process.exit(2); }
if (!target) die('usage: npm run scan -- <mcp-url | snapshot.json> [--json] [--trusted a,b] [--fail-on warn] [--no-fetch]   or   --card <url | file>');
if (failOn !== 'none' && severityRank(failOn) < 0) die('--fail-on must be info, warn, high or none');

const isUrl = /^https?:\/\//i.test(target);
let input;
let notes = [];
try {
  if (cardTarget) {
    let text;
    if (isUrl) {
      const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } else text = fs.readFileSync(target, 'utf8');
    input = { card: JSON.parse(text) };
  } else if (isUrl) {
    const auth = process.env.MCPTOOLS_SCAN_AUTHORIZATION;
    const client = createHttpClient({ url: target, getAuth: auth ? () => ['Authorization', auth] : undefined });
    const got = await collectFromClient(client, { fetchContent: !noFetch });
    notes = got.notes;
    input = got;
  } else {
    input = parseSnapshot(fs.readFileSync(target, 'utf8'));
  }
} catch (e) {
  die(`could not read ${target}: ${e.message}`);
}

const { findings, truncated } = analyze(input, { trustedNames: trusted });
const report = buildReport({ findings, truncated, input, source: { type: cardTarget ? 'agent-card' : isUrl ? 'url' : 'file', label: isUrl ? target.split('?')[0] : target }, trustedNames: trusted });
if (notes.length) report.notes = notes;

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  const i = report.input;
  console.log(`[scanner] scanned ${i.tools} tool(s), ${i.resources} resource(s), ${i.prompts} prompt(s)${i.card ? ', 1 agent card' : ''}\n`);
  for (const f of report.findings) {
    console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.ruleId}  ${f.subject}: ${f.detail}`);
    for (const e of f.evidence) console.log(`        at ${e.field} [${e.start}-${e.end}]  ${e.excerpt}`);
  }
  for (const n of notes) console.log(`note: ${n}`);
  console.log(report.findings.length ? `\n${report.summary.high} high, ${report.summary.warn} warn, ${report.summary.info} info.` : 'no findings');
  console.log(`This scan reports only; it never blocks. ${LIMITS[4].text}`);
}
const worst = report.findings.reduce((m, f) => Math.max(m, severityRank(f.severity)), -1);
process.exit(failOn !== 'none' && worst >= severityRank(failOn) ? 1 : 0);
