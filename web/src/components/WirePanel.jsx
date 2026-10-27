import React from "react";
import { CLAIM_NOTES, SPEC_URL, TERMS } from "../lib/wire.js";

// "On the wire": request, response, the token decoded claim by claim, and what the step protects against.
// All values are examples. `wire` comes from lib/wire.js.
const fmt = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));

function Message({ title, m }) {
  return (
    <div className="wire__msg">
      <h4>{title}</h4>
      {m ? <pre className="wire__pre" data-testid={`wire-${title.toLowerCase()}`}>{[m.line, ...m.headers, ...(m.body ? ["", m.body] : [])].join("\n")}</pre>
        : <p className="muted small">None on this step.</p>}
    </div>
  );
}

function Token({ t }) {
  const rows = [
    ...Object.entries(t.header).map(([k, v]) => ["header." + k, v, k]),
    ...Object.entries(t.payload).map(([k, v]) => [k, v, k]),
  ];
  return (
    <div className="wire__token">
      <h4>Token: {t.label}</h4>
      <p className="wire__jwt" data-testid="wire-jwt"><span className="jwt-h">{t.raw[0]}</span>.<span className="jwt-p">{t.raw[1]}</span>.<span className="jwt-s">{t.raw[2]}</span></p>
      <table className="rules">
        <thead><tr><th scope="col">Claim</th><th scope="col">Value</th><th scope="col">What this means</th></tr></thead>
        <tbody>{rows.map(([label, v, k]) => (
          <tr key={label} className={t.focus.includes(k) ? "wire__focus" : ""}><td><code>{label}</code></td><td><code>{fmt(v)}</code></td><td>{CLAIM_NOTES[k] || "A custom claim."}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function WirePanel({ wire, heading = "On the wire" }) {
  return (
    <div className="wire" data-testid="wire">
      <h3>{heading} <span className="badge">Example</span></h3>
      {wire.title && <p><strong>{wire.title}</strong></p>}
      {wire.traffic ? (
        <>
          <div className="wire__cols">
            <Message title="Request" m={wire.req} />
            <Message title="Response" m={wire.res} />
          </div>
          {wire.token && <Token t={wire.token} />}
        </>
      ) : (
        <>
          <p className="muted" data-testid="wire-none">{wire.none}</p>
          {wire.res && <Message title="Response" m={wire.res} />}
        </>
      )}
      <p className="wire__notice"><strong>What to notice:</strong> {wire.notice}</p>
      <details>
        <summary className="small">Words used here</summary>
        <dl className="small">{TERMS.map(([t, d]) => <React.Fragment key={t}><dt><strong>{t}</strong></dt><dd>{d}</dd></React.Fragment>)}</dl>
        <p className="small"><a href={SPEC_URL} target="_blank" rel="noreferrer">Read the MCP authorization specification</a></p>
      </details>
    </div>
  );
}
