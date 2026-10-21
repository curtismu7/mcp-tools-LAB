// scan-report/1: the machine-readable result of one scan. Schema in docs/scan-report.schema.json.
import fs from 'node:fs';
import { LIMITS, RULES, SEVERITIES, severityRank } from './rules.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export function buildReport({ findings, truncated = false, input = {}, source = { type: 'snapshot' }, trustedNames = [], now = new Date() }) {
  const sorted = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const summary = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) summary[f.severity] += 1;
  return {
    schema: 'scan-report/1',
    scannedAt: now.toISOString(),
    scanner: { name: 'mcp-tools', version, enforcement: 'none' },
    source,
    input: { tools: input.tools?.length ?? 0, resources: input.resources?.length ?? 0, prompts: input.prompts?.length ?? 0, card: Boolean(input.card), trustedNames: trustedNames.length, truncated },
    summary: { ...summary, total: findings.length },
    findings: sorted,
    rules: Object.entries(RULES).map(([id, r]) => ({ id, severity: r.severity, kind: r.kind, title: r.title })),
    limits: LIMITS,
  };
}
