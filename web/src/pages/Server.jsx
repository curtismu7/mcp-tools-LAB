import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, post, pretty } from "../lib/api.js";
import { Untrusted, spansFor } from "../lib/Untrusted.jsx";
import CallPanel from "../components/CallPanel.jsx";
import ConfirmCall from "../components/ConfirmCall.jsx";
import ScanResult, { SeverityBadge, downloadReport, worst } from "../components/ScanResult.jsx";

// One connected server: Tools / Resources / Prompts, the Scan button, the scan result, then the call panel. The scan
// result lives in App (scans[id]) so it survives moving between pages in this session.
const sigOf = (t) => JSON.stringify([t?.description ?? "", t?.inputSchema ?? null]);
const TABS = [["tools", "Tools"], ["resources", "Resources"], ["prompts", "Prompts"]];

// The text at an evidence path such as "inputSchema.properties.url.default" inside one listed tool.
function fieldText(tool, field) {
  let v = tool;
  for (const k of String(field).split(".")) v = v && typeof v === "object" ? v[k] : undefined;
  return typeof v === "string" ? v : null;
}

export default function Server({ conn, scan, onScanned, onMissing }) {
  const [tab, setTab] = useState("tools");
  const [tools, setTools] = useState(scan?.listed.tools || null);
  const [others, setOthers] = useState(scan ? { resources: scan.listed.resources, prompts: scan.listed.prompts } : null);
  const [err, setErr] = useState(null);
  const [changed, setChanged] = useState([]);
  const [trusted, setTrusted] = useState("");
  const [fetchContent, setFetchContent] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [methods, setMethods] = useState([]);
  const seen = useRef(new Map()); // name -> signature of the list last shown
  const base = `/api/connections/${encodeURIComponent(conn?.id || "")}`;

  const remember = useCallback((list) => { seen.current = new Map((list || []).map((t) => [t.name, sigOf(t)])); }, []);
  // Compare a new list with the one last shown; a tool whose text changed is the rug-pull signal.
  const diff = useCallback((list) => (seen.current.size ? list.filter((t) => seen.current.has(t.name) && seen.current.get(t.name) !== sigOf(t)).map((t) => t.name) : []), []);

  const list = useCallback(async () => {
    setErr(null);
    const r = await get(`${base}/tools`);
    if (!r.ok) { setErr(r.data?.message || "Could not list tools."); if (r.status === 404) onMissing?.(); return; }
    setChanged(diff(r.data.tools));
    remember(r.data.tools);
    setTools(r.data.tools);
  }, [base, diff, remember, onMissing]);

  useEffect(() => {
    if (!conn) return;
    if (scan) remember(scan.listed.tools); else { setTools(null); setOthers(null); list(); }
    get("/api/protocol-methods").then((r) => setMethods(r.data?.methods || []));
  }, [conn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resources and prompts are listed on first visit to their tab when no scan has listed them yet.
  useEffect(() => {
    if (!conn || tab === "tools" || others) return;
    (async () => {
      const [res, pr] = await Promise.all([post(`${base}/rpc`, { method: "resources/list" }), post(`${base}/rpc`, { method: "prompts/list" })]);
      setOthers({ resources: res.ok ? res.data.result?.resources || [] : [], prompts: pr.ok ? pr.data.result?.prompts || [] : [] });
    })();
  }, [tab, others, conn, base]);

  async function runScan() {
    setScanning(true); setErr(null); setStatus("Scanning: listing tools, resources and prompts. No tool is called.");
    const r = await post(`${base}/scan`, { trustedNames: trusted.split(",").map((s) => s.trim()).filter(Boolean), fetchContent });
    setScanning(false);
    if (!r.ok) { setStatus(""); setErr(r.data?.message || "Scan failed."); return; }
    setChanged(diff(r.data.listed.tools));
    remember(r.data.listed.tools);
    setTools(r.data.listed.tools);
    setOthers({ resources: r.data.listed.resources, prompts: r.data.listed.prompts });
    onScanned(conn.id, r.data);
    const s = r.data.report.summary;
    setStatus(s.total === 0 ? "Scan finished: no known pattern found." : `Scan finished: ${s.total} finding(s), ${s.high} high.`);
  }

  const report = scan?.report || null;
  const findings = report?.findings || [];
  const bySubject = useCallback((name) => findings.filter((f) => f.subject === name), [findings]);
  const resolve = useCallback((f, e) => { const t = (tools || []).find((x) => x.name === f.subject); return t ? fieldText(t, e.field) : null; }, [tools]);
  const flaggedBy = useCallback((name) => worst(bySubject(name)), [bySubject]);
  const stale = useMemo(() => changed.length > 0 && report, [changed, report]);

  if (!conn) return (<><h2>Server</h2><p className="notice">No server is connected. Go to Connect, choose a saved connection and press Open.</p></>);

  return (
    <>
      <h2>Server: <Untrusted text={conn.label} /></h2>
      <p className="lede">{conn.transport === "http" ? <Untrusted text={conn.url} /> : conn.transport}{conn.token === "set" ? " · token set" : ""}</p>
      {!scan && <p className="notice" data-testid="scan-banner"><strong>Scan before first use.</strong> This connection has not been scanned. What is listed below is what an agent would be given as trusted context. Press Scan before you call anything.</p>}
      {changed.length > 0 && (
        <p className="alert" role="alert" data-testid="changed">
          The tool list changed since the one you last saw: <Untrusted text={changed.join(", ")} />. {stale ? "Your scan is of the older list. Scan again." : "Scan before you trust it."}
        </p>
      )}

      <div className="card">
        <div className="controls">
          <button type="button" className="btn primary" onClick={runScan} disabled={scanning}>{scanning ? "Scanning..." : "Scan"}</button>
          <button type="button" className="btn" onClick={() => { setTools(null); list(); }} disabled={scanning}>Refresh list</button>
        </div>
        <div className="fields">
          <label>Trusted tool names from your other servers (comma separated, optional)
            <input value={trusted} onChange={(e) => setTrusted(e.target.value)} placeholder="get_balance, send_email" />
          </label>
          <label className="check"><input type="checkbox" checked={fetchContent} onChange={(e) => setFetchContent(e.target.checked)} /> Also read resource and prompt content (reads only; no tool is called)</label>
        </div>
        <p role="status" aria-live="polite" data-testid="scan-status">{status}</p>
      </div>

      <div className="tabs" role="tablist" aria-label="What the server offers">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} className="btn" onClick={() => setTab(id)}
            onKeyDown={(e) => { const i = TABS.findIndex(([x]) => x === tab); if (e.key === "ArrowRight") setTab(TABS[(i + 1) % 3][0]); if (e.key === "ArrowLeft") setTab(TABS[(i + 2) % 3][0]); }}>
            {label}{id === "tools" && tools ? ` (${tools.length})` : ""}
          </button>
        ))}
      </div>
      <div className="card" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {err && <p className="alert" role="alert">{err}</p>}
        {tab === "tools" && (
          <>
            {!tools && !err && <p className="muted">Listing...</p>}
            {tools && tools.length === 0 && <p className="muted">The server lists no tools.</p>}
            {tools && (
              <ul className="tool-list">
                {tools.map((t, i) => {
                  const w = flaggedBy(t.name);
                  return (
                    <li key={`${t.name}-${i}`} className="tool">
                      <strong><Untrusted text={t.name} spans={spansFor(findings, t.name, "name")} /></strong> {w && <SeverityBadge severity={w} />}
                      <div className="small"><Untrusted text={t.description || ""} spans={spansFor(findings, t.name, "description")} /></div>
                      <details>
                        <summary className="small">Input schema (shown as text)</summary>
                        <Untrusted block text={pretty(t.inputSchema ?? null)} />
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        {tab === "resources" && <Others items={others?.resources} kind="resource" idKey="uri" findings={findings} />}
        {tab === "prompts" && <Others items={others?.prompts} kind="prompt" idKey="name" findings={findings} />}
      </div>

      <h3>Scan result</h3>
      {report ? <ScanResult report={report} resolve={resolve} onDownload={() => downloadReport(report)} /> : <p className="muted">No scan yet. Press Scan to judge the metadata above.</p>}

      <h3>Call a tool</h3>
      <div className="card">
        <CallPanel connectionId={conn.id} tools={tools} scanned={!!scan} flaggedBy={flaggedBy} />
      </div>

      <details className="card" data-admin-only>
        <summary>Other protocol methods (resources, prompts, completion, logging)</summary>
        <ProtocolMethod connectionId={conn.id} methods={methods} />
      </details>
    </>
  );
}

function Others({ items, kind, idKey, findings }) {
  if (!items) return <p className="muted">Listing...</p>;
  if (items.length === 0) return <p className="muted">The server lists no {kind}s.</p>;
  return (
    <ul className="tool-list">
      {items.map((it, i) => {
        const subject = `${kind}:${it[idKey] ?? it.name}`;
        const w = worst(findings.filter((f) => f.subject === subject));
        return (
          <li key={i} className="tool">
            <strong><Untrusted text={it.name || it.uri} /></strong> {w && <SeverityBadge severity={w} />}
            {it.uri && it.name && <div className="small muted"><Untrusted text={it.uri} /></div>}
            <div className="small"><Untrusted text={it.description || ""} /></div>
            {Array.isArray(it.arguments) && it.arguments.length > 0 && <div className="small muted">Arguments: <Untrusted text={it.arguments.map((a) => a?.name).join(", ")} /></div>}
          </li>
        );
      })}
    </ul>
  );
}

function ProtocolMethod({ connectionId, methods }) {
  const [method, setMethod] = useState("resources/list");
  const [text, setText] = useState("{}");
  const params = useMemo(() => { try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } }, [text]);
  const def = methods.find((m) => m.method === method);
  return (
    <>
      <div className="fields">
        <label>Method
          <select value={method} onChange={(e) => setMethod(e.target.value)}>{methods.map((m) => <option key={m.method} value={m.method}>{m.method}</option>)}</select>
        </label>
        {def && <p className="small muted">{def.description}</p>}
        <label>Params (JSON object)<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></label>
      </div>
      {params === null ? <p className="alert">Params must be a JSON object.</p> : <ConfirmCall connectionId={connectionId} kind="rpc" name={method} params={params} />}
    </>
  );
}
