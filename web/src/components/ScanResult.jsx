import React from "react";
import { Untrusted } from "../lib/Untrusted.jsx";

export const SEV = { high: "High", warn: "Warn", info: "Info" };
const ORDER = ["high", "warn", "info"];

export function SeverityBadge({ severity }) {
  return <span className={`sev sev--${severity}`}>{SEV[severity] || severity}</span>;
}

export function worst(findings) {
  return ORDER.find((s) => findings.some((f) => f.severity === s)) || null;
}

// The scan result's wording. "Nothing found" is never "safe": the scan only knows the shapes it has rules for.
export function verdict(report) {
  const { summary } = report;
  if (summary.total === 0) return { tone: "none", head: "No known pattern found", body: "That is not a statement that this server is safe. The scan checks the metadata it read against known shapes of poison, and nothing more." };
  if (summary.high > 0) return { tone: "high", head: "High-severity patterns found", body: "Read the evidence below before an agent ingests this metadata. The scan reports; it does not block anything." };
  if (summary.warn > 0) return { tone: "warn", head: "Patterns worth a look found", body: "None is high severity, but each one deserves a read. The scan reports; it does not block anything." };
  return { tone: "info", head: "Notes only", body: "Only informational notes. The scan reports; it does not block anything." };
}

// [U+XXXX] tokens in an excerpt (the scanner writes invisible characters that way) become chips; everything is text nodes.
const TOKEN = /(\[U\+[0-9A-F]{4,6}\])/g;
function Chips({ text }) {
  return String(text).split(TOKEN).map((p, i) => (i % 2 ? <span key={i} className="inv" title="Invisible character, made visible">{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>));
}

// The matched span, with up to 60 characters either side when the full field text is at hand (`context`).
function Evidence({ e, context }) {
  const full = typeof context === "string" && e.end <= context.length ? context : null;
  if (!full) return <mark className="evidence__hit"><Chips text={e.excerpt} /></mark>;
  const from = Math.max(0, e.start - 60);
  return (
    <>
      {from > 0 && "…"}<Untrusted text={full.slice(from, Math.min(full.length, e.end + 60))} spans={[{ start: e.start - from, end: e.end - from }]} />{e.end + 60 < full.length && "…"}
    </>
  );
}

/** The result of a scan: verdict, findings by severity with evidence, the limits box, and a report download. */
export default function ScanResult({ report, resolve, onDownload }) {
  if (!report) return null;
  const { summary, findings } = report;
  const titles = Object.fromEntries((report.rules || []).map((r) => [r.id, r.title]));
  const v = verdict(report);
  return (
    <section aria-label="Scan result" className="findings" data-testid="scan-result">
      <div className={`verdict verdict--${v.tone}`} data-testid="verdict">
        <h3 className="verdict__head">{v.head}</h3>
        <p>{v.body}</p>
        <p role="status" aria-live="polite" data-testid="summary">
          {summary.total === 0 ? "0 findings." : `${summary.total} finding(s): ${summary.high} high, ${summary.warn} warn, ${summary.info} info.`}
          {report.input.truncated ? " The scan was truncated: part of the input was not scanned." : ""}
        </p>
        <p className="small muted">Scanned {report.input.tools} tool(s), {report.input.resources ?? 0} resource(s), {report.input.prompts ?? 0} prompt(s) at {report.scannedAt}. A scan reports. It never blocks and never changes a server's data.</p>
        {onDownload && <button type="button" className="btn" onClick={onDownload}>Download scan-report/1 (JSON)</button>}
      </div>

      {ORDER.filter((s) => summary[s] > 0).map((sev) => {
        const group = findings.filter((f) => f.severity === sev);
        return (
          <section key={sev} aria-labelledby={`sev-${sev}`}>
            <h4 id={`sev-${sev}`}><SeverityBadge severity={sev} /> {SEV[sev]} ({group.length})</h4>
            <ul className="finding-list">
              {group.map((f, i) => (
                <li key={i} className="finding">
                  <div className="finding__head">
                    <code>{f.ruleId}</code> <span className="muted small">{f.kind}</span> <strong><Untrusted text={f.subject} /></strong>
                    {f.arg !== undefined && <span className="muted"> argument <code><Untrusted text={f.arg} /></code></span>}
                  </div>
                  {titles[f.ruleId] && <p className="finding__rule"><strong>What the rule flags:</strong> {titles[f.ruleId]}</p>}
                  <p className="finding__detail"><strong>What it found:</strong> <Untrusted text={f.detail} /></p>
                  {f.evidence.map((e, j) => (
                    <p key={j} className="evidence small">
                      <span className="muted">Evidence at <code>{e.field}</code> [{e.start}-{e.end}]:</span>{" "}
                      <span className="untrusted" data-testid="evidence"><Evidence e={e} context={resolve?.(f, e)} /></span>
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {report.notes?.length > 0 && <ul className="small muted">{report.notes.map((n, i) => <li key={i}><Untrusted text={n} /></li>)}</ul>}

      <aside className="card inner cannot" aria-labelledby="cannot-h" data-testid="cannot-catch">
        <h4 id="cannot-h">What this scan cannot catch</h4>
        <ul>{(report.limits || []).map((l) => <li key={l.id}>{l.text}</li>)}</ul>
      </aside>
    </section>
  );
}

export function downloadReport(report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `scan-report-${report.scannedAt.replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
