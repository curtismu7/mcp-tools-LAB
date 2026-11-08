import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { del, get, post, pretty, put } from "../lib/api.js";
import { buildBrief, downloadBrief } from "../lib/brief.js";
import FlagControl from "../components/FlagControl.jsx";
import OAuthPanel from "../components/OAuthPanel.jsx";
import { Untrusted, spansFor } from "../lib/Untrusted.jsx";
import CallPanel from "../components/CallPanel.jsx";
import ConfirmCall from "../components/ConfirmCall.jsx";
import ScanResult, { SeverityBadge, downloadReport, worst } from "../components/ScanResult.jsx";
import { estimateTokens, TOKEN_NOTE } from "../lib/tokens.js";

// One connected server: Tools / Resources / Prompts, the Scan button, the scan result, then the call panel. The scan
// result lives in App (scans[id]) so it survives moving between pages in this session.
const sigOf = (t) => JSON.stringify([t?.description ?? "", t?.inputSchema ?? null]);
// One value for a whole tool list, so "the list the scan covered" can be compared with "the list shown now".
const listKey = (list) => JSON.stringify((list || []).map((t) => [t?.name, sigOf(t)]).sort());
const TABS = [["tools", "Tools"], ["resources", "Resources"], ["prompts", "Prompts"]];

// The text at an evidence path such as "inputSchema.properties.url.default" inside one listed tool.
function fieldText(tool, field) {
  let v = tool;
  for (const k of String(field).split(".")) v = v && typeof v === "object" ? v[k] : undefined;
  return typeof v === "string" ? v : null;
}

export default function Server({ conn, scan, onScanned, onMissing, mockOnly = false }) {
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
  const [flags, setFlags] = useState([]);
  const [flagErr, setFlagErr] = useState("");
  const [briefNote, setBriefNote] = useState("");
  const loadFlags = useCallback(async () => { const r = await get(`${base}/flags`); setFlags(r.ok ? r.data.flags || [] : []); }, [base]);
  useEffect(() => { if (conn) loadFlags(); }, [conn?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const flagOf = useCallback((kind, name) => flags.find((f) => f.kind === kind && f.name === name) || null, [flags]);
  async function saveFlag(kind, name, note) {
    setFlagErr("");
    const r = await put(`${base}/flags`, { kind, name, note });
    if (!r.ok) { setFlagErr(r.data?.message || `Could not save the flag (${r.status}).`); return false; }
    loadFlags(); return true;
  }
  async function removeFlag(flag) { await del(`${base}/flags/${encodeURIComponent(flag.id)}`); loadFlags(); }
  const flagProps = { onSave: saveFlag, onRemove: removeFlag, disabled: mockOnly };
  const [running, setRunning] = useState(null); // the tool whose card has its call panel open (Run), one at a time

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
  // Is the scan of the list that is shown now? "none" = never scanned, "older" = the list changed since the scan.
  const scanCover = useMemo(() => (!report ? "none" : !tools || listKey(report ? scan.listed.tools : []) === listKey(tools) ? "current" : "older"), [report, scan, tools]);

  if (!conn) return (
    <>
      <h2>Server</h2>
      <section className="card" aria-labelledby="teach-h">
        <h3 id="teach-h">What this page teaches</h3>
        <p>An MCP server describes its tools, resources and prompts to whatever connects to it. The text it sends is trusted by the model, so you have to look at it before you use it.</p>
        <p><strong>How to run it</strong></p>
        <ol>
          <li>Go to <strong>Connect</strong> in the menu above.</li>
          <li>Press <strong>Open the clean sample server</strong>, or <strong>Open the hostile sample server</strong>. The hostile one has hidden instructions in its descriptions.</li>
          <li>Come back here. The tools, resources and prompts it lists appear. Nothing is called yet.</li>
          <li>Press <strong>Scan</strong>. The rules read the descriptions and report what they find. A clean result is not proof of safety.</li>
          <li>Read the findings. Only then, if you want, call a tool. The confirm dialog shows the exact arguments first.</li>
        </ol>
        <p className="muted">Try both samples and compare the scan results. That difference is the lesson.</p>
      </section>
    </>
  );

  return (
    <>
      <h2>Server: <Untrusted text={conn.label} /></h2>
      <p className="lede">{conn.transport === "http" ? <Untrusted text={conn.url} /> : conn.transport}{conn.token === "set" ? " · token set" : ""}</p>
      {conn.transport === "http" && !mockOnly && <OAuthPanel conn={conn} onSignedIn={() => { setTools(null); list(); }} />}
      {!scan && <p className="notice" data-testid="scan-banner"><strong>Scan before first use.</strong> This connection has not been scanned. What is listed below is what an agent would be given as trusted context. Press Scan before you call anything.</p>}
      {(changed.length > 0 || scanCover === "older") && (
        <p className="alert" role="alert" data-testid="changed">
          {changed.length > 0 && <>The tool list changed since the one you last saw: <Untrusted text={changed.join(", ")} />. </>}
          {scanCover === "none" && "Scan before you trust it."}
          {scanCover === "older" && "The list changed since your last scan, so that scan does not cover it. Scan again."}
          {scanCover === "current" && "Your last scan covers this changed list. Read its findings."}
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
            {tools && tools.length > 0 && <p className="small muted" data-testid="list-tokens">This list costs an agent ~{estimateTokens({ tools })} tokens of context before it calls anything ({TOKEN_NOTE}).</p>}
            {tools && (
              <ul className="tool-list">
                {tools.map((t, i) => {
                  const w = flaggedBy(t.name);
                  return (
                    <li key={`${t.name}-${i}`} className="tool">
                      <strong><Untrusted text={t.name} spans={spansFor(findings, t.name, "name")} /></strong> {w && <SeverityBadge severity={w} />} <span className="tok" data-testid="tool-tokens">~{estimateTokens(t)} tokens</span>
                      <div className="small"><Untrusted text={t.description || ""} spans={spansFor(findings, t.name, "description")} /></div>
                      <details>
                        <summary className="small">Input schema (shown as text)</summary>
                        <Untrusted block text={pretty(t.inputSchema ?? null)} />
                      </details>
                      <div className="flag-row">
                        <button type="button" className={running === t.name ? "btn" : "btn primary"} aria-expanded={running === t.name} aria-label={`${running === t.name ? "Close" : "Run"} ${t.name}`}
                          onClick={() => setRunning((r) => (r === t.name ? null : t.name))}>{running === t.name ? "Close" : "Run"}</button>
                      </div>
                      {running === t.name && (
                        <div className="inline-run" data-testid="inline-run">
                          <CallPanel key={t.name} connectionId={conn.id} tools={tools} scanned={!!scan} flaggedBy={flaggedBy} onScan={runScan} scanning={scanning} fixedTool={t.name} />
                        </div>
                      )}
                      <FlagControl kind="tool" name={t.name} flag={flagOf("tool", t.name)} {...flagProps} />
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        {flagErr && <p className="alert" role="alert">{flagErr}</p>}
        {tab === "resources" && <Others items={others?.resources} kind="resource" idKey="uri" findings={findings} flagOf={flagOf} flagProps={flagProps} />}
        {tab === "prompts" && <Others items={others?.prompts} kind="prompt" idKey="name" findings={findings} flagOf={flagOf} flagProps={flagProps} />}
      </div>

      <h3>Scan result</h3>
      {report ? <ScanResult report={report} resolve={resolve} onDownload={() => downloadReport(report)} /> : <p className="muted">No scan yet. Press Scan to judge the metadata above.</p>}

      <h3>Review brief</h3>
      <div className="card" data-testid="brief">
        <p className="small">Flag tools, resources or prompts above with a note, then download a Markdown brief for a coding agent or a reviewer: your notes, the server's definitions and the scan findings. Server text sits in fenced blocks marked as untrusted data, so the brief does not pass the poison on. {flags.length} flagged{flags.length ? "" : ": with nothing flagged the brief still lists every scan finding"}{report ? "" : ". Scan first to include findings"}.</p>
        <div className="controls">
          <button type="button" className="btn" onClick={() => setBriefNote(`Downloaded ${downloadBrief(buildBrief({ conn, listed: { tools: tools || [], resources: others?.resources || [], prompts: others?.prompts || [] }, report, flags }), conn.label)}.`)}>Download review brief (Markdown)</button>
          {briefNote && <span className="small" role="status">{briefNote}</span>}
        </div>
        {(flags.length > 0 || report) && (
          <details>
            <summary className="small">Preview the brief</summary>
            <Untrusted block text={buildBrief({ conn, listed: { tools: tools || [], resources: others?.resources || [], prompts: others?.prompts || [] }, report, flags })} />
          </details>
        )}
      </div>

      <h3>Call a tool</h3>
      <div className="card">
        <CallPanel connectionId={conn.id} tools={tools} scanned={!!scan} flaggedBy={flaggedBy} onScan={runScan} scanning={scanning} />
      </div>

      <details className="card" data-admin-only>
        <summary>Other protocol methods (resources, prompts, completion, logging)</summary>
        <ProtocolMethod connectionId={conn.id} methods={methods} />
      </details>
    </>
  );
}

function Others({ items, kind, idKey, findings, flagOf, flagProps }) {
  if (!items) return <p className="muted">Listing...</p>;
  if (items.length === 0) return <p className="muted">The server lists no {kind}s.</p>;
  return (
    <>
    <p className="small muted">These {kind}s cost ~{estimateTokens(items)} tokens to list ({TOKEN_NOTE}).</p>
    <ul className="tool-list">
      {items.map((it, i) => {
        const subject = `${kind}:${it[idKey] ?? it.name}`;
        const w = worst(findings.filter((f) => f.subject === subject));
        return (
          <li key={i} className="tool">
            <strong><Untrusted text={it.name || it.uri} /></strong> {w && <SeverityBadge severity={w} />} <span className="tok">~{estimateTokens(it)} tokens</span>
            {it.uri && it.name && <div className="small muted"><Untrusted text={it.uri} /></div>}
            <div className="small"><Untrusted text={it.description || ""} /></div>
            {Array.isArray(it.arguments) && it.arguments.length > 0 && <div className="small muted">Arguments: <Untrusted text={it.arguments.map((a) => a?.name).join(", ")} /></div>}
            {typeof (it[idKey] ?? it.name) === "string" && <FlagControl kind={kind} name={it[idKey] ?? it.name} flag={flagOf(kind, it[idKey] ?? it.name)} {...flagProps} />}
          </li>
        );
      })}
    </ul>
    </>
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
