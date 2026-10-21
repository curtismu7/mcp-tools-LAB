import React, { useEffect, useState } from "react";
import { get } from "../lib/api.js";

export default function Limits() {
  const [data, setData] = useState(null);
  useEffect(() => { get("/api/rules").then((r) => setData(r.data)); }, []);
  return (
    <>
      <h2>What a metadata scan does not catch</h2>
      <p className="lede">The scanner is a tripwire in front of the agent. It is honest about its limits, and so is every report it writes.</p>
      <div className="card">
        {!data ? <p className="muted">Loading...</p> : <ul>{data.limits.map((l) => <li key={l.id}>{l.text}</li>)}</ul>}
      </div>
      <h3>Rules</h3>
      <div className="card">
        {data && (
          <table className="rules">
            <thead><tr><th scope="col">Id</th><th scope="col">Severity</th><th scope="col">What it flags</th></tr></thead>
            <tbody>{data.rules.map((r) => <tr key={r.id}><td><code>{r.id}</code></td><td><span className={`sev sev--${r.severity}`}>{r.severity}</span></td><td>{r.title}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
