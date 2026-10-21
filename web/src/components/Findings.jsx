import React from "react";
import { Untrusted } from "../lib/Untrusted.jsx";

export const SEV = { high: "High", warn: "Warn", info: "Info" };

export function SeverityBadge({ severity }) {
  return <span className={`sev sev--${severity}`}>{SEV[severity] || severity}</span>;
}

export function worst(findings) {
  return ["high", "warn", "info"].find((s) => findings.some((f) => f.severity === s)) || null;
}

/** The result of a scan: counts in words, the reports-only statement, and every finding with its evidence. */
export default function Findings({ report }) {
  if (!report) return null;
  const { summary, findings } = report;
  return (
    <section aria-label="Scan findings" className="findings">
      <p className="notice" role="note">This scan reports. It never blocks, never changes the server's data, and a clean result is not proof of safety (see Limits).</p>
      <p role="status" aria-live="polite" data-testid="summary">
        {summary.total === 0
          ? "No findings."
          : `${summary.total} finding(s): ${summary.high} high, ${summary.warn} warn, ${summary.info} info.`}
        {report.input.truncated ? " The scan was truncated: part of the input was not scanned." : ""}
      </p>
      <ul className="finding-list">
        {findings.map((f, i) => (
          <li key={i} className="finding">
            <div className="finding__head">
              <SeverityBadge severity={f.severity} /> <code>{f.ruleId}</code> <strong><Untrusted text={f.subject} /></strong>
              {f.arg !== undefined && <span className="muted"> argument <code><Untrusted text={f.arg} /></code></span>}
            </div>
            <p className="finding__detail"><Untrusted text={f.detail} /></p>
            {f.evidence.map((e, j) => (
              <p key={j} className="evidence small">
                <span className="muted">at <code>{e.field}</code> [{e.start}-{e.end}]:</span> <Untrusted text={e.excerpt} />
              </p>
            ))}
          </li>
        ))}
      </ul>
      {report.notes?.length > 0 && <ul className="small muted">{report.notes.map((n, i) => <li key={i}><Untrusted text={n} /></li>)}</ul>}
    </section>
  );
}
