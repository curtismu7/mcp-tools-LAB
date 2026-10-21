// The scanner library. `analyze` and `buildReport` are the rich API (rule ids, severities, evidence spans).
// `scan`, `scanResources`, `scanPrompts`, `scanAgentCard` keep the original mcp-scanner return shape, [{tool, kind, detail}],
// one entry per tool/argument/kind, so code written against the source scanner keeps working.
import { analyze } from './engine.js';

export { analyze, DEFAULT_BUDGET } from './engine.js';
export { buildReport } from './report.js';
export { parseSnapshot, SnapshotError } from './snapshot.js';
export { LIMITS, RULES, SEVERITIES, severityRank } from './rules.js';
export { visible } from './unicode.js';

// Original kinds only; the added rule kinds (unicode, credential, shadowing, ...) are reported by `analyze` only.
function legacy(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!['hidden-instruction', 'exfil-sink', 'sensitive-action'].includes(f.kind)) continue;
    const key = `${f.subject}|${f.kind}|${f.arg ?? ''}`;
    const g = groups.get(key) || { tool: f.subject, kind: f.kind, arg: f.arg, details: [] };
    g.details.push(f.detail);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ tool: g.tool, kind: g.kind, detail: g.arg !== undefined ? `arg "${g.arg}": ${g.details.join('; ')}` : g.details.join('; ') }));
}

export const scan = (tools) => legacy(analyze({ tools }).findings);
export const scanResources = (resources) => legacy(analyze({ resources }).findings);
export const scanPrompts = (prompts) => legacy(analyze({ prompts }).findings);
export const scanAgentCard = (card) => legacy(analyze({ card }).findings);
