import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Untrusted } from "../lib/Untrusted.jsx";
import { get, post } from "../lib/api.js";

// Real mode of the Entitled listing page: the same questions asked of a real gateway's MCP aggregate apps, with the
// operator's agent keys (server/src/gateway/real.js; keys never reach the browser). Only a name that is NOT in the
// caller's listing is ever called from here, to test the refusal. Which check a refusal matches is our reading.

// What a refusal reading highlights in the six checks. "policy" cannot be split: the gateway does not say which policy.
export const REAL_LAYERS = { "tool-filter": ["tool-filter"], policy: ["member-policy", "aggregate-cap"], unreachable: ["unreachable"], unknown: ["unknown"], key: [], other: [] };
const READING_TEXT = {
  "tool-filter": "matches check 4, the ToolFilter",
  policy: "matches a policy check (5 or 6); the gateway does not say which",
  unreachable: "matches check 2, a member the gateway could not reach",
  unknown: "matches check 1, no such tool",
  key: "the gateway did not accept the agent key, before any check",
  other: "does not match a known check",
};
const members = (tools) => Object.entries(tools.reduce((m, t) => { const a = t.name.includes("__") ? t.name.split("__")[0] : "(no alias)"; m[a] = (m[a] || 0) + 1; return m; }, {}));

export default function GatewayReal({ onLayer }) {
  const [info, setInfo] = useState(null);
  const [caller, setCaller] = useState("");
  const [lists, setLists] = useState({});
  const [app, setApp] = useState("");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    get("/api/gateway/real").then((r) => {
      setInfo(r.ok ? r.data : { available: false, problem: r.data?.message || `The server did not answer (${r.status}).` });
      if (r.ok && r.data.available) { setCaller(r.data.callers[0].id); setApp(r.data.apps[0]); }
    });
  }, []);

  // One caller against every configured app, one after the other (a few requests, never a burst).
  const compare = useCallback(async () => {
    if (!info?.available || !caller) return;
    setBusy(true); setLists({}); setResult(null); onLayer(null);
    const out = {};
    for (const a of info.apps) {
      const r = await post("/api/gateway/real/list", { app: a, caller });
      out[a] = r.ok ? r.data : { ok: false, refusal: { status: r.status, message: r.data?.message || "the request failed", layer: "other" } };
      setLists({ ...out });
    }
    setBusy(false);
  }, [info, caller, onLayer]);
  useEffect(() => { compare(); }, [compare]);

  const cur = lists[app];
  const hiddenHere = useMemo(() => {
    if (!cur?.ok) return [];
    const here = new Set(cur.tools.map((t) => t.name));
    return [...new Set(Object.entries(lists).filter(([a, l]) => a !== app && l.ok).flatMap(([, l]) => l.tools.map((t) => t.name)))].filter((n) => !here.has(n)).slice(0, 24);
  }, [lists, app, cur]);

  if (!info) return <p className="muted">Asking this app whether Real is set up...</p>;
  if (!info.available) return <p className="alert" role="alert" data-testid="real-problem">{info.problem}</p>;
  const callerLabel = info.callers.find((c) => c.id === caller)?.label ?? caller;

  async function call() {
    setBusy(true);
    const r = await post("/api/gateway/real/call", { app, caller, tool: tool.trim(), confirm: true });
    setBusy(false);
    const res = r.ok ? r.data : { ok: false, blocked: true, message: r.data?.message || `The request failed (${r.status}).` };
    setResult({ ...res, name: tool.trim(), app });
    onLayer(r.ok && !r.data.ok ? r.data.refusal.layer : null);
  }

  return (
    <>
      <p className="notice" role="note" data-testid="real-note"><strong>Real:</strong> measured on your gateway with the agent key for {callerLabel}. {info.reading}</p>
      <div className="card controls" role="group" aria-label="Who is asking">
        <label>Caller (agent key)
          <select value={caller} onChange={(e) => setCaller(e.target.value)} disabled={busy}>{info.callers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </label>
        <button type="button" className="btn" onClick={compare} disabled={busy}>Ask again</button>
      </div>

      <h3>What {callerLabel} sees in each aggregate app (tools/list)</h3>
      <div className="card gw__scroll" aria-busy={busy}>
        <table className="gw__table" data-testid="real-compare">
          <thead><tr><th scope="col">App</th><th scope="col">Result</th><th scope="col">Members (tools)</th><th scope="col">Time</th></tr></thead>
          <tbody>
            {info.apps.map((a) => {
              const l = lists[a];
              return (
                <tr key={a} data-state={!l ? "pending" : l.ok ? "listed" : "hidden"}>
                  <td><label className="gw__check"><input type="radio" name="real-app" checked={app === a} onChange={() => { setApp(a); setResult(null); onLayer(null); }} /> <code>{a}</code></label></td>
                  <td>{!l ? "asking..." : l.ok ? <><strong>{l.tools.length}</strong> tool(s) listed</> : <>refused{l.refusal.status ? ` (${l.refusal.status})` : ""}: <Untrusted text={l.refusal.message} /></>}</td>
                  <td>{l?.ok ? members(l.tools).map(([m, n]) => `${m} (${n})`).join(", ") || "none" : ""}</td>
                  <td>{l ? `${l.ms} ms` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {cur?.ok && (
        <>
          <h3>Listed for {callerLabel} in <code>{app}</code></h3>
          <div className="card gwl__box">
            <ul className="gw__tools" aria-label="Listed tools">
              {cur.tools.map((t) => <li key={t.name}><code>{t.name}</code> <span className="muted small"><Untrusted text={t.description} /></span></li>)}
            </ul>
          </div>
        </>
      )}

      <h3>Call a hidden tool by name</h3>
      <div className="card">
        <p className="muted small">Only a name that is not in {callerLabel}'s listing for <code>{app}</code> is sent, with no arguments, to test that the gateway refuses it. A listed tool is called from the Server page, behind the confirm dialog.</p>
        {hiddenHere.length > 0 && (
          <div className="gwl__chips" role="group" aria-label="Listed in another app but hidden here">
            <span className="muted small">Listed in another app but hidden here:</span>
            {hiddenHere.map((n) => <button key={n} type="button" className="btn small" onClick={() => setTool(n)}><code>{n}</code></button>)}
          </div>
        )}
        <div className="gw__row">
          <label className="gw__field gw__grow">Tool name
            <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="alias__tool" spellCheck={false} />
          </label>
        </div>
        <label className="gw__check"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Send a real tools/call to the gateway. If the gateway wrongly allows it, that tool runs with no arguments.</label>
        <div className="gw__row">
          <button type="button" className="btn primary" onClick={call} disabled={busy || !confirm || !tool.trim() || !cur}>Call</button>
        </div>
        {result && (
          <div className="gw__result" data-testid="real-call-result" data-state={result.ok && !result.isError ? "allowed" : "refused"} role="status">
            {result.blocked
              ? <p><strong>Not sent.</strong> {result.message}</p>
              : result.ok
                ? <p><strong>{result.isError ? "Reached the tool, which answered with an error" : "Allowed"}: the gateway did not refuse a tool it did not list.</strong> <Untrusted text={result.text} /></p>
                : <p><strong>Refused{result.refusal.status ? ` (${result.refusal.status})` : ""}.</strong> <Untrusted text={result.refusal.message} /> <span className="muted">Our reading: {READING_TEXT[result.refusal.layer]}.</span></p>}
          </div>
        )}
      </div>
    </>
  );
}
