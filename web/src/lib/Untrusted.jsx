import React from "react";

// Everything a server sends is untrusted. It is only ever rendered as React text nodes (never innerHTML), so markup in
// a payload is shown, not run. Invisible and bidi characters are shown as [U+XXXX]. `spans` are evidence offsets from a
// scan report (UTF-16 offsets into this exact string); they get a <mark> that carries the text, not colour alone.
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ﻿ﾠ\u{E0000}-\u{E007F}]/gu;

export function visible(s) {
  return String(s ?? "").replace(CONTROLS, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
}

function plain(text, key) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(CONTROLS)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span className="inv" key={`${key}-${m.index}`} title="Invisible character, made visible">{visible(m[0])}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function segments(text, spans = []) {
  const s = String(text ?? "");
  const sorted = [...spans].filter((p) => p.end > p.start && p.start < s.length).sort((a, b) => a.start - b.start);
  const out = [];
  let at = 0;
  for (const p of sorted) {
    if (p.start < at) continue; // overlapping spans: the first one wins
    if (p.start > at) out.push({ text: s.slice(at, p.start), hot: false });
    out.push({ text: s.slice(p.start, Math.min(p.end, s.length)), hot: true, rule: p.ruleId });
    at = Math.min(p.end, s.length);
  }
  if (at < s.length) out.push({ text: s.slice(at), hot: false });
  return out;
}

export function Untrusted({ text, spans, block = false }) {
  const Tag = block ? "pre" : "span";
  return (
    <Tag className={`untrusted${block ? " untrusted--block" : ""}`} data-testid="untrusted">
      {segments(text, spans).map((p, i) => (p.hot
        ? <mark key={i} title={p.rule ? `Flagged by ${p.rule}` : "Flagged"}>{plain(p.text, i)}</mark>
        : <React.Fragment key={i}>{plain(p.text, i)}</React.Fragment>))}
    </Tag>
  );
}

// The evidence spans a report holds for one subject's field, as {start, end, ruleId}.
export function spansFor(findings, subject, field) {
  return (findings || []).flatMap((f) => (f.subject === subject ? f.evidence.filter((e) => e.field === field).map((e) => ({ start: e.start, end: e.end, ruleId: f.ruleId })) : []));
}
