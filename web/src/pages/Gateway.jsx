import React, { useEffect, useRef, useState } from "react";
import ScanResult from "../components/ScanResult.jsx";
import { Untrusted } from "../lib/Untrusted.jsx";
import { post } from "../lib/api.js";
import {
  ALIAS, BANNER, LAYER_TEXT, STATUS_TEXT, allQualified, granted, renameAlias, setMember,
  toggleCap, toggleLinked, togglePolicy, toggleToolFilter,
} from "../lib/gateway.js";
import "./Gateway.css";

// Entitled listing and aggregate cap. A SIMULATION in this process of a Ping release claim (2026-11-02), UNVERIFIED on our
// tenant: there is no live path until that release is on our tenant. Every result below comes from the server's
// /api/gateway routes (the engine), not from text in this file.

function AliasField({ value, taken, onCommit, label }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const ok = ALIAS.test(draft) && !taken.includes(draft);
  return (
    <label className="gw__field">{label}
      <input value={draft} aria-invalid={!ok} onChange={(e) => { setDraft(e.target.value); if (ALIAS.test(e.target.value) && !taken.includes(e.target.value)) onCommit(e.target.value); }} />
      {!ok && <span className="gw__hint" role="note">Lowercase letters, digits and dashes, starting with a letter, up to 16, and not used by another member.</span>}
    </label>
  );
}

function Check({ checked, onChange, label, disabled }) {
  return <label className="gw__check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
}

export default function Gateway({ gw }) {
  const { state, patch, edit, reset, ready, error } = gw;
  const { config, caller, view, member } = state;
  const [listing, setListing] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [toolName, setToolName] = useState("");
  const seq = useRef(0);

  // Re-evaluate whenever the config, the caller, the view or the member changes.
  useEffect(() => {
    if (!config) return undefined;
    const my = ++seq.current;
    setBusy(true);
    const body = { config, caller, view, ...(view === "direct" ? { member } : {}) };
    Promise.all([post("/api/gateway/list", body), post("/api/gateway/audit", body)]).then(([l, a]) => {
      if (my !== seq.current) return;
      setBusy(false);
      if (l.ok && a.ok) { setListing(l.data); setRows(a.data.rows); setErr(null); }
      else { setListing(null); setRows(null); setErr(l.data?.message || a.data?.message || `The simulated gateway refused the request (${l.status}).`); }
    });
    return () => { seq.current += 1; };
  }, [config, caller, view, member]);

  if (error) return <p className="alert" role="alert">{error}</p>;
  if (!ready) return <p className="muted">Loading the simulated gateway...</p>;

  const callers = config.callers;
  const callerLabel = callers.find((c) => c.id === caller)?.label ?? caller;
  const names = allQualified(config);
  const aliases = (id) => config.members.filter((m) => m.id !== id).map((m) => m.alias);
  const direct = view === "direct";
  const memberObj = config.members.find((m) => m.id === member) ?? config.members[0];

  async function call() {
    setBusy(true);
    const r = await post("/api/gateway/call", { config, caller, view, ...(direct ? { member } : {}), tool: toolName.trim() });
    setBusy(false);
    patch({ call: { status: r.status, ok: r.ok, data: r.data, name: toolName.trim() } });
  }
  async function scan() {
    setBusy(true);
    const r = await post("/api/gateway/scan", { config, caller, view, ...(direct ? { member } : {}) });
    setBusy(false);
    patch({ scan: r.ok ? { report: r.data.report, caller: callerLabel, view: direct ? `member ${memberObj.alias} used directly` : "the aggregate" } : { error: r.data?.message || `The scan failed (${r.status}).` } });
  }

  const c = state.call;
  return (
    <>
      <h2>Entitled listing and aggregate cap</h2>
      <p className="lede"><strong>{BANNER}.</strong> This page simulates it in this process: nothing leaves this computer and there is no live path until the release is on our tenant. Pick a caller and look at what the gateway lists, then call a tool by name that you were not shown.</p>

      <div className="card controls" role="group" aria-label="Who is asking, and through what">
        <label>Caller
          <select value={caller} onChange={(e) => patch({ caller: e.target.value, call: null, scan: null })}>{callers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        </label>
        <div className="seg" role="group" aria-label="Reach the tools through">
          <button type="button" className="btn" aria-pressed={!direct} onClick={() => patch({ view: "aggregate", call: null, scan: null })}>Through the aggregate</button>
          <button type="button" className="btn" aria-pressed={direct} onClick={() => patch({ view: "direct", call: null, scan: null })}>One member directly</button>
        </div>
        {direct && (
          <label>Member
            <select value={memberObj.id} onChange={(e) => patch({ member: e.target.value, call: null, scan: null })}>{config.members.map((m) => <option key={m.id} value={m.id}>{m.alias}</option>)}</select>
          </label>
        )}
        <button type="button" className="btn" onClick={reset} disabled={busy}>Reset</button>
      </div>
      {err && <p className="alert" role="alert">{err}</p>}

      <h3>What {callerLabel} sees (tools/list)</h3>
      <div className="card" aria-busy={busy} data-testid="listing">
        {!listing ? <p className="muted">Loading...</p> : (
          <>
            <p data-testid="listing-count"><strong>{listing.tools.length}</strong> tool(s) listed. {direct ? "Names are the member's own." : "Names are prefixed by the member alias, alias__tool."} Tools this caller is not entitled to are not in the list, and the list does not say how many there are.</p>
            <ul className="gw__tools" aria-label="Listed tools">
              {listing.tools.map((t) => <li key={t.name}><code>{t.name}</code> <span className="muted small"><Untrusted text={t.description} /></span></li>)}
            </ul>
            <h4>Members</h4>
            <ul className="gw__members" aria-label="Member status">
              {listing.members.map((m) => <li key={m.alias} data-state={m.status}><code>{m.alias}</code>: {STATUS_TEXT[m.status]}{m.status !== "ok" && " (reported, not dropped)"}</li>)}
            </ul>
          </>
        )}
      </div>

      <h3>Call a tool by name</h3>
      <div className="card">
        <p className="muted small">Type any name, including one that is not in the list above. A tool hidden from the list is refused here too.</p>
        <div className="gw__row">
          <label className="gw__field gw__grow">Tool name
            <input value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder={direct ? "tool" : "alias__tool"} spellCheck={false} />
          </label>
          <button type="button" className="btn primary" onClick={call} disabled={busy || !toolName.trim()}>Call</button>
        </div>
        {c && (
          <div className="gw__result" data-testid="call-result" data-state={c.ok ? "allowed" : "refused"} role="status">
            {c.ok
              ? <p><strong>Allowed.</strong> {c.data?.result?.content?.[0]?.text}</p>
              : <p><strong>Refused ({c.status}).</strong> {c.data?.message}</p>}
            {c.data?.demoTrace && (
              <>
                <p className="muted small">{c.data.demoTrace.note}</p>
                <ol className="gw__trace" aria-label="Demo trace">
                  {c.data.demoTrace.steps.map((s, i) => <li key={i}>{s.stage}: {s.decision}{s.layer !== "none" && ` (${LAYER_TEXT[s.layer] || s.layer})`}</li>)}
                </ol>
              </>
            )}
          </div>
        )}
      </div>

      <h3>Scan this listing</h3>
      <div className="card">
        <p className="muted small">The scanner reads the list exactly as {callerLabel} sees it. A tool hidden from this caller is not scanned.</p>
        <button type="button" className="btn" onClick={scan} disabled={busy || !listing}>Scan as {callerLabel}</button>
        {state.scan?.error && <p className="alert" role="alert">{state.scan.error}</p>}
        {state.scan?.report && (
          <div data-testid="gateway-scan">
            <p><strong>Scanned as {state.scan.caller}, through {state.scan.view}.</strong></p>
            <ScanResult report={state.scan.report} />
          </div>
        )}
      </div>

      <h3>Demo audit view</h3>
      <div className="card">
        <p className="muted small"><strong>Not what the caller sees.</strong> This view names the tools that were hidden from {callerLabel} and the first layer that stopped each one.</p>
        <div className="gw__scroll">
          <table className="gw__table" data-testid="audit">
            <thead><tr><th scope="col">Tool</th><th scope="col">Result</th><th scope="col">Stopped by</th></tr></thead>
            <tbody>
              {(rows || []).map((r) => <tr key={r.name} data-state={r.visible ? "listed" : "hidden"}><td><code>{r.name}</code></td><td>{r.visible ? "listed" : "hidden"}</td><td>{r.layer ? LAYER_TEXT[r.layer] : "nothing"}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>

      <h3>Edit the policy</h3>
      <details className="card" open>
        <summary>Members, member policy and the aggregate cap</summary>
        <p className="muted small">Every box here is a policy field the gateway reads. Change one and the lists above change. Reset puts them all back.</p>
        {config.members.map((m) => (
          <fieldset className="gw__member" key={m.id}>
            <legend><code>{m.id}</code> member</legend>
            <div className="gw__row">
              <AliasField label="Alias" value={m.alias} taken={aliases(m.id)} onCommit={(a) => edit(renameAlias(config, m.id, a))} />
              <Check label="Reachable" checked={m.reachable} onChange={(on) => edit(setMember(config, m.id, { reachable: on }))} />
              <Check label="Needs each caller's own sign-in (per-user upstream)" checked={m.upstream === "per-user"} onChange={(on) => edit(setMember(config, m.id, { upstream: on ? "per-user" : "none" }))} />
            </div>
            {m.upstream === "per-user" && (
              <div className="gw__row" role="group" aria-label={`Callers signed in to ${m.alias}`}>
                <span className="muted small">Signed in to {m.alias}:</span>
                {callers.map((x) => <Check key={x.id} label={x.label} checked={m.linkedCallers.includes(x.id)} onChange={(on) => edit(toggleLinked(config, m.id, x.id, on))} />)}
              </div>
            )}
            <div className="gw__scroll">
              <table className="gw__table">
                <caption className="gw__caption">{m.alias}: ToolFilter (exposed through the aggregate) and the member's own policy per caller</caption>
                <thead><tr><th scope="col">Tool</th><th scope="col">In ToolFilter</th>{callers.map((x) => <th scope="col" key={x.id}>{x.label} allowed</th>)}</tr></thead>
                <tbody>
                  {m.tools.map((t) => (
                    <tr key={t.name}>
                      <td><code>{t.name}</code></td>
                      <td><input type="checkbox" aria-label={`${m.alias} ToolFilter includes ${t.name}`} checked={m.toolFilter.includes(t.name)} onChange={(e) => edit(toggleToolFilter(config, m.id, t.name, e.target.checked))} /></td>
                      {callers.map((x) => <td key={x.id}><input type="checkbox" aria-label={`${m.alias} policy lets ${x.label} use ${t.name}`} checked={granted(m.policy, x.id, t.name)} onChange={(e) => edit(togglePolicy(config, m.id, x.id, t.name, e.target.checked))} /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </fieldset>
        ))}
        <fieldset className="gw__member">
          <legend>Aggregate policy cap</legend>
          <p className="muted small">The cap only removes: it limits what a member already allows. It is checked on the list and again at the member hop.</p>
          <div className="gw__scroll">
            <table className="gw__table">
              <caption className="gw__caption">What the aggregate allows each caller</caption>
              <thead><tr><th scope="col">Tool</th>{callers.map((x) => <th scope="col" key={x.id}>{x.label} allowed</th>)}</tr></thead>
              <tbody>
                {names.map((n) => (
                  <tr key={n}>
                    <td><code>{n}</code></td>
                    {callers.map((x) => <td key={x.id}><input type="checkbox" aria-label={`cap lets ${x.label} use ${n}`} checked={granted(config.cap, x.id, n)} onChange={(e) => edit(toggleCap(config, x.id, n, e.target.checked))} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>
      </details>

      <h3>Where each name comes from</h3>
      <div className="card">
        <p className="muted small">Swagger names are schema names only: nothing was called. The behaviour is a deck claim and is not measured on our tenant.</p>
        <div className="gw__scroll">
          <table className="gw__table" data-testid="provenance">
            <thead><tr><th scope="col">Name or claim</th><th scope="col">Tag</th><th scope="col">Note</th></tr></thead>
            <tbody>{(state.provenance || []).map((p) => <tr key={p.name}><td>{p.name}</td><td>{state.tags?.[p.tag] ?? p.tag}</td><td>{p.note}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </>
  );
}
