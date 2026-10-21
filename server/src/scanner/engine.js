// The scan engine. Heuristics ported from AI-DEMO2 standalone/mcp-scanner/scanner.mjs (MIT): the patterns for
// hidden-instruction, exfil-sink and sensitive-action are the original ones. Added: a rule id and severity per finding,
// evidence spans (offsets into the original string), unicode checks, credential-harvest and name-shadowing rules, and a
// size/depth/count budget so hostile input ends in a "scan truncated" finding, not a crash.
// It reads metadata only: it never calls a tool, and it never blocks anything.
import { RULES } from './rules.js';
import { isLoopbackHost } from '../security.js';
import { skeleton, unicodeHits, visible } from './unicode.js';

export const DEFAULT_BUDGET = { maxDepth: 32, maxNodes: 20_000, maxChars: 1_048_576, maxStringChars: 20_000, maxFindings: 500, longDescription: 2_000 };

const INSTRUCTION_TAG = /<\/?\s*(important|system|secret|instructions?|admin)\s*>/i;
const SECRECY = /\bdo not (tell|mention|inform|reveal|disclose|notify)\b/i;
const AGENT_IMPERATIVE = /\b(ignore (all )?previous|before (calling|using) (any|another) tool|you must (always|first)|always call)\b/i;
const LEAK_HINT = /\b(full (conversation )?context|credentials?|api[- ]?keys?|secrets?|passwords?|bearer|auth(entication)? tokens?|tokens?)\b/i;
const SENSITIVE_ACTION = /\b(transfer|payment|payout|wire|remit)\b/i;
const APPROVAL_BYPASS = /\b(bypass|skip|without|no)\b[^.\n]{0,40}\b(approval|consent|authorization)\b/i;
const CRED_COLLECT = /\b(collect|gather|ask for|request|obtain|prompt for|include|send|provide)\b[^.\n]{0,60}\b(passwords?|passcodes?|one[- ]time (code|pass\w*)|otp|mfa (code|token)|credentials?|secrets?|api[- ]?keys?|bearer tokens?)\b/i;
const CRED_ARG = /^(password|passwd|pwd|passcode|otp|mfa[_-]?(code|token)|secret|client[_-]?secret|api[_-]?key|token|access[_-]?token)$/i;
const PRIMACY = /\bauthoritative\b[^.]{0,40}\b(tool|function)\b|\bignore (any|all) other\b[^.]{0,30}\b(tools?|functions?)\b/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const HI = [['MT-HI-001', INSTRUCTION_TAG], ['MT-HI-002', SECRECY], ['MT-HI-003', AGENT_IMPERATIVE]];
const CONTENT_KEYS = new Set(['description', 'text', 'title']);
// Which rule groups run on which kind of string.
const CLASS_RULES = {
  name: [],
  'tool-desc': ['HI', 'CR', 'SH', 'DS'],
  'arg-desc': ['HI', 'LEAK'],
  skill: ['HI', 'LEAK'],
  value: ['OFFBOX'],
  content: ['HI', 'SA'],
  text: ['HI'],
};

function isOffBox(hostOrEmail) {
  const host = hostOrEmail.includes('@') ? hostOrEmail.split('@').pop() : (() => { try { return new URL(hostOrEmail).hostname; } catch { return ''; } })();
  return host !== '' && !isLoopbackHost(host);
}

const fieldName = (path) => path.map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${p}`)).join('');

export function createScan(opts = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(opts.budget || {}) };
  const trusted = new Map((opts.trustedNames || []).map(String).filter(Boolean).map((n) => [n, skeleton(n)]));
  const findings = [];
  const truncated = new Map(); // reason -> { count, first }
  const used = { nodes: 0, chars: 0 };
  let capped = false;

  function add(ruleId, subject, detail, { field, start = 0, end = 0, text = '', arg } = {}) {
    if (findings.length >= budget.maxFindings) { capped = true; return; }
    const rule = RULES[ruleId];
    const excerpt = visible(text.slice(start, Math.min(end, start + 200)));
    findings.push({ ruleId, severity: rule.severity, kind: rule.kind, subject, ...(arg !== undefined ? { arg } : {}), detail, evidence: field ? [{ field, start, end, excerpt }] : [] });
  }
  function cut(reason, where) {
    const t = truncated.get(reason) || { count: 0, first: where };
    t.count += 1;
    truncated.set(reason, t);
  }

  // Run the text rules for one string leaf.
  function checkString(text, cls, { subject, path, arg }) {
    const field = fieldName(path);
    const ctx = { field, text, arg };
    const groups = CLASS_RULES[cls] || [];
    let s = text;
    if (s.length > budget.maxStringChars) { cut('string', `${subject} ${field}`); s = s.slice(0, budget.maxStringChars); }
    const hit = (ruleId, m, detail) => add(ruleId, subject, detail, { ...ctx, start: m.index, end: m.index + m[0].length });

    for (const h of unicodeHits(s)) add(h.ruleId, subject, h.detail, { ...ctx, start: h.start, end: h.end });
    if (groups.includes('HI')) {
      for (const [id, re] of HI) { const m = re.exec(s); if (m) hit(id, m, `${RULES[id].title}: "${visible(m[0])}"`); }
    }
    if (groups.includes('LEAK')) { const m = LEAK_HINT.exec(s); if (m) hit('MT-EX-002', m, 'description instructs including sensitive context'); }
    if (groups.includes('SA')) {
      const a = SENSITIVE_ACTION.exec(s); if (a) hit('MT-SA-001', a, 'content directs the agent toward a fund-moving or payment action');
      const b = APPROVAL_BYPASS.exec(s); if (b) hit('MT-SA-002', b, 'content instructs the agent to bypass approval or consent');
    }
    if (groups.includes('CR')) { const m = CRED_COLLECT.exec(s); if (m) hit('MT-CR-001', m, `description tells the agent to collect secrets: "${visible(m[0])}"`); }
    if (groups.includes('SH')) { const m = PRIMACY.exec(s); if (m) hit('MT-SH-003', m, `description claims primacy over another tool: "${visible(m[0])}"`); }
    if (groups.includes('DS') && text.length > budget.longDescription) add('MT-DS-001', subject, `description is ${text.length} characters long`, { ...ctx, start: 0, end: 0 });
    if (groups.includes('OFFBOX')) {
      for (const m of [...s.matchAll(URL_IN_TEXT), ...s.matchAll(EMAIL_IN_TEXT)]) {
        if (isOffBox(m[0])) hit('MT-EX-001', m, `off-box default ${visible(m[0])}`);
      }
    }
  }

  // Depth-, node- and cycle-limited walk over every string leaf of a value.
  function walk(value, path, depth, ancestors, visit, keyVisit) {
    if (used.nodes >= budget.maxNodes) { cut('nodes', fieldName(path)); return; }
    used.nodes += 1;
    if (typeof value === 'string') {
      used.chars += value.length;
      if (used.chars > budget.maxChars) { cut('chars', fieldName(path)); return; }
      visit(value, path);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (depth >= budget.maxDepth) { cut('depth', fieldName(path)); return; }
    if (ancestors.has(value)) { cut('cycle', fieldName(path)); return; }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { if (used.nodes >= budget.maxNodes) { cut('nodes', fieldName(path)); break; } walk(value[i], [...path, i], depth + 1, ancestors, visit, keyVisit); }
    } else {
      for (const k of Object.keys(value)) {
        if (used.nodes >= budget.maxNodes) { cut('nodes', fieldName(path)); break; }
        if (path.at(-1) === 'properties') keyVisit?.(k, [...path, k]);
        walk(value[k], [...path, k], depth + 1, ancestors, visit, keyVisit);
      }
    }
    ancestors.delete(value);
  }

  const classifyTool = (path) => {
    const last = path.at(-1);
    if (path.length === 1 && last === 'name') return 'name';
    if (path.length === 1 && last === 'description') return 'tool-desc';
    if (path.includes('default') || path.includes('const') || path.includes('enum') || path.includes('examples')) return 'value';
    if (last === 'description' && path.includes('properties')) return 'arg-desc';
    return 'text';
  };

  const nameSeen = new Set();
  function checkToolName(name, subject) {
    if (nameSeen.has(name)) add('MT-SH-004', subject, `another tool in this list is also named "${visible(name)}"`, { field: 'name', start: 0, end: name.length, text: name });
    nameSeen.add(name);
    if (trusted.has(name)) add('MT-SH-001', subject, `"${visible(name)}" is already a trusted tool name; the agent may resolve to this one`, { field: 'name', start: 0, end: name.length, text: name });
    else {
      const sk = skeleton(name);
      for (const [t, tsk] of trusted) if (tsk === sk) add('MT-SH-002', subject, `"${visible(name)}" looks like trusted tool "${visible(t)}"`, { field: 'name', start: 0, end: name.length, text: name });
    }
  }

  function tools(list) {
    for (const [i, tool] of (Array.isArray(list) ? list : []).entries()) {
      if (!tool || typeof tool !== 'object') continue;
      const subject = typeof tool.name === 'string' && tool.name ? tool.name : `(tool #${i})`;
      if (typeof tool.name === 'string') checkToolName(tool.name, subject);
      walk(tool, [], 0, new Set(), (text, path) => {
        const cls = classifyTool(path);
        // Property names are also checked as text for unicode tricks.
        checkString(text, cls, { subject, path, arg: path.includes('properties') ? path[path.lastIndexOf('properties') + 1] : undefined });
      }, (key, path) => {
        if (CRED_ARG.test(key)) add('MT-CR-002', subject, `argument "${visible(key)}" is named like a credential`, { field: fieldName(path), start: 0, end: key.length, text: key, arg: key });
        for (const h of unicodeHits(key)) add(h.ruleId, subject, `argument name: ${h.detail}`, { field: fieldName(path), start: h.start, end: h.end, text: key, arg: key });
      });
    }
  }

  function content(list, label, nameOf) {
    for (const [i, item] of (Array.isArray(list) ? list : []).entries()) {
      if (!item || typeof item !== 'object') continue;
      const subject = `${label}:${nameOf(item) || `(unnamed #${i})`}`;
      // Only the text a model would read is judged as content; uri, mimeType and similar get the unicode checks only.
      walk(item, [], 0, new Set(), (text, path) => checkString(text, CONTENT_KEYS.has(path.at(-1)) ? 'content' : 'name', { subject, path }));
    }
  }
  const resources = (list) => content(list, 'resource', (r) => String(r.uri || '').split('/').filter(Boolean).pop() || r.name);
  const prompts = (list) => content(list, 'prompt', (p) => p.name);

  // An A2A Agent Card: the card description is plain text, each skill description can instruct and leak.
  function card(c) {
    if (!c || typeof c !== 'object') return;
    const label = `card:${c.name || 'agent'}`;
    walk({ description: c.description }, [], 0, new Set(), (text, path) => checkString(text, 'text', { subject: label, path }));
    for (const [i, s] of (Array.isArray(c.skills) ? c.skills : []).entries()) {
      const subject = `skill:${s?.id || s?.name || '(unnamed)'}`;
      walk({ description: s?.description }, ['skills', i], 0, new Set(), (text, path) => checkString(text, 'skill', { subject, path }));
    }
  }

  function finish() {
    for (const [reason, t] of truncated) {
      const what = { depth: `nesting deeper than ${budget.maxDepth} levels`, nodes: `more than ${budget.maxNodes} values`, chars: `more than ${budget.maxChars} characters in total`, string: `a string longer than ${budget.maxStringChars} characters`, cycle: 'a cyclic reference' }[reason];
      findings.push({ ruleId: 'MT-LM-001', severity: RULES['MT-LM-001'].severity, kind: 'scan-truncated', subject: 'scan', detail: `scan truncated: ${what} (${t.count} place(s), first at ${t.first || 'the top'}); the rest of that input was NOT scanned`, evidence: [] });
    }
    if (capped) findings.push({ ruleId: 'MT-LM-001', severity: 'warn', kind: 'scan-truncated', subject: 'scan', detail: `scan truncated: more than ${budget.maxFindings} findings; later ones were dropped`, evidence: [] });
    return { findings, truncated: truncated.size > 0 || capped };
  }

  return { tools, resources, prompts, card, finish };
}

/** Rich findings for a snapshot: { tools, resources, prompts, card }. */
export function analyze(input = {}, opts = {}) {
  const s = createScan(opts);
  s.tools(input.tools);
  s.resources(input.resources);
  s.prompts(input.prompts);
  s.card(input.card);
  return s.finish();
}
