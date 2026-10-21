import React, { useCallback, useEffect, useMemo, useState } from "react";
import { del, get, post } from "../lib/api.js";
import { Untrusted, spansFor } from "../lib/Untrusted.jsx";
import ConfirmCall from "../components/ConfirmCall.jsx";
import Findings, { SeverityBadge, worst } from "../components/Findings.jsx";

const blankForm = { label: "", transport: "http", url: "", authHeader: "Authorization", token: "", command: "", args: "", env: "" };

function parseEnv(text) {
  return Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)]));
}

function ConnectForm({ config, onCreated }) {
  const [f, setF] = useState(blankForm);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const body = f.transport === "http"
      ? { transport: "http", label: f.label, url: f.url, authHeader: f.authHeader, token: f.token }
      : f.transport === "stdio"
        ? { transport: "stdio", label: f.label, command: f.command, args: f.args, env: parseEnv(f.env) }
        : { transport: "pingone", label: f.label || "PingOne hosted MCP" };
    const r = await post("/api/connections", body);
    setBusy(false);
    setF((p) => ({ ...p, token: "", env: "" })); // a secret is never left in the form
    if (!r.ok) { setMsg({ ok: false, text: r.data?.message || "Could not save the connection." }); return; }
    setMsg(r.data.test.ok
      ? { ok: true, text: `Connected to ${r.data.test.serverInfo?.name || "server"} ${r.data.test.serverInfo?.version || ""} (protocol ${r.data.test.protocolVersion}).` }
      : { ok: false, text: `Saved, but the test failed: ${r.data.test.error}` });
    onCreated(r.data.connection);
  }

  return (
    <form className="card" onSubmit={submit} aria-labelledby="connect-h">
      <h3 id="connect-h">New connection</h3>
      <div className="seg" role="group" aria-label="Transport">
        {["http", "stdio", ...(config?.pingone?.enabled ? ["pingone"] : [])].map((t) => (
          <button key={t} type="button" className="btn" aria-pressed={f.transport === t} onClick={() => setF((p) => ({ ...p, transport: t }))}>
            {t === "http" ? "Streamable HTTP" : t === "stdio" ? "stdio command" : "PingOne hosted (optional)"}
          </button>
        ))}
      </div>
      <div className="fields">
        <label>Name<input value={f.label} onChange={set("label")} placeholder="optional" /></label>
        {f.transport === "http" && (
          <>
            <label>Server URL<input value={f.url} onChange={set("url")} placeholder="http://127.0.0.1:8899/mcp" required /></label>
            <label>Auth header name<input value={f.authHeader} onChange={set("authHeader")} /></label>
            <label>Auth header value (optional)<input type="password" autoComplete="off" value={f.token} onChange={set("token")} placeholder="Bearer ..." /></label>
          </>
        )}
        {f.transport === "stdio" && (
          <>
            <p className="notice" role="note">This launches the command below on this machine, with no shell. Only commands you type here are run.</p>
            <label>Command<input value={f.command} onChange={set("command")} placeholder="npx" required /></label>
            <label>Arguments<input value={f.args} onChange={set("args")} placeholder="-y @modelcontextprotocol/server-everything stdio" /></label>
            <label>Environment (KEY=value per line)<textarea rows={2} value={f.env} onChange={set("env")} autoComplete="off" /></label>
            <p className="small muted">The command gets a minimal environment (PATH, HOME, and what you list here). It lives in memory for this session only.</p>
          </>
        )}
        {f.transport === "pingone" && <p className="small muted">Optional, untested here. Sign in with the PingOne controls in the README first.</p>}
      </div>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Connecting..." : "Connect and test"}</button>
      {msg && <p className={msg.ok ? "ok" : "alert"} role="status">{msg.text}</p>}
    </form>
  );
}

export default function Workbench({ config }) {
  const [conns, setConns] = useState([]);
  const [sel, setSel] = useState("");
  const [tools, setTools] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [report, setReport] = useState(null);
  const [listed, setListed] = useState(null);
  const [trusted, setTrusted] = useState("");
  const [fetchContent, setFetchContent] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState(null);
  const [tool, setTool] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [method, setMethod] = useState("resources/list");
  const [paramsText, setParamsText] = useState("{}");
  const [methods, setMethods] = useState([]);

  const loadConns = useCallback(async () => { const r = await get("/api/connections"); setConns(r.data?.connections || []); }, []);
  useEffect(() => { loadConns(); get("/api/protocol-methods").then((r) => setMethods(r.data?.methods || [])); }, [loadConns]);

  const choose = useCallback(async (id) => {
    setSel(id); setTools(null); setReport(null); setListed(null); setListErr(null); setScanErr(null); setTool("");
    if (!id) return;
    const r = await get(`/api/connections/${encodeURIComponent(id)}/tools`);
    if (r.ok) setTools(r.data.tools); else setListErr(r.data?.message || "Could not list tools.");
  }, []);

  async function scan() {
    setScanning(true); setScanErr(null);
    const r = await post(`/api/connections/${encodeURIComponent(sel)}/scan`, { trustedNames: trusted.split(",").map((s) => s.trim()).filter(Boolean), fetchContent });
    setScanning(false);
    if (r.ok) { setReport(r.data.report); setListed(r.data.listed); setTools(r.data.listed.tools); } else setScanErr(r.data?.message || "Scan failed.");
  }

  const findings = report?.findings || [];
  const toolFindings = useCallback((name) => findings.filter((f) => f.subject === name), [findings]);
  const args = useMemo(() => { try { const v = JSON.parse(argsText); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } }, [argsText]);
  const params = useMemo(() => { try { const v = JSON.parse(paramsText); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } }, [paramsText]);
  const picked = (tools || []).find((t) => t.name === tool);
  const pickedWorst = picked ? worst(toolFindings(picked.name)) : null;
  const selected = conns.find((c) => c.id === sel);
  const methodDef = methods.find((m) => m.method === method);

  return (
    <>
      <h2>Connect, see, judge, then call</h2>
      <p className="lede">Four steps in order. You can look and scan without calling anything; a call needs a scan first and an explicit confirm.</p>

      <h3>1. Connect</h3>
      <div className="card">
        {conns.length === 0 ? <p className="muted">No saved connections yet.</p> : (
          <ul className="conn-list">
            {conns.map((c) => (
              <li key={c.id}>
                <button type="button" className="btn" aria-pressed={sel === c.id} onClick={() => choose(c.id)}>
                  <Untrusted text={c.label} /> <span className="muted small">{c.transport}{c.transport === "http" ? ` ${c.url}` : ""}{c.token === "set" ? ", token set" : ""}</span>
                </button>
                <button type="button" className="btn" aria-label={`Remove ${c.label}`} onClick={async () => { await del(`/api/connections/${encodeURIComponent(c.id)}`); if (sel === c.id) choose(""); loadConns(); }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConnectForm config={config} onCreated={(c) => { loadConns(); choose(c.id); }} />

      {sel && (
        <>
          <h3>2. See what <Untrusted text={selected?.label || "the server"} /> offers</h3>
          <div className="card">
            {listErr && <p className="alert">{listErr}</p>}
            {!tools && !listErr && <p className="muted">Listing...</p>}
            {tools && tools.length === 0 && <p className="muted">The server lists no tools.</p>}
            {tools && (
              <ul className="tool-list">
                {tools.map((t, i) => {
                  const w = worst(toolFindings(t.name));
                  return (
                    <li key={`${t.name}-${i}`} className="tool">
                      <strong><Untrusted text={t.name} spans={spansFor(findings, t.name, "name")} /></strong> {w && <SeverityBadge severity={w} />}
                      <div className="small"><Untrusted text={t.description || ""} spans={spansFor(findings, t.name, "description")} /></div>
                    </li>
                  );
                })}
              </ul>
            )}
            {listed && (listed.resources.length > 0 || listed.prompts.length > 0) && (
              <p className="small muted">Also listed: {listed.resources.length} resource(s), {listed.prompts.length} prompt(s). Their content is judged in the scan.</p>
            )}
          </div>

          <h3>3. Judge the metadata before an agent ingests it</h3>
          <div className="card">
            <div className="fields">
              <label>Trusted tool names from your other servers (comma separated, optional)
                <input value={trusted} onChange={(e) => setTrusted(e.target.value)} placeholder="get_balance, send_email" />
              </label>
              <label className="check"><input type="checkbox" checked={fetchContent} onChange={(e) => setFetchContent(e.target.checked)} /> Also read resource and prompt content (reads only; no tool is called)</label>
            </div>
            <button type="button" className="btn primary" onClick={scan} disabled={scanning}>{scanning ? "Scanning..." : "Scan"}</button>
            {scanErr && <p className="alert">{scanErr}</p>}
            <Findings report={report} />
          </div>

          <h3>4. Call</h3>
          <div className="card">
            {!report ? <p className="muted" data-testid="call-locked">Scan first. Calls unlock after a scan of this server in this session.</p> : (
              <>
                <div className="fields">
                  <label>Tool
                    <select value={tool} onChange={(e) => setTool(e.target.value)}>
                      <option value="">Choose a tool</option>
                      {(tools || []).map((t, i) => <option key={`${t.name}-${i}`} value={t.name}>{t.name}</option>)}
                    </select>
                  </label>
                  <label>Arguments (JSON object)
                    <textarea rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} spellCheck={false} />
                  </label>
                </div>
                {args === null && <p className="alert">Arguments must be a JSON object.</p>}
                {tool && args && (
                  <ConfirmCall connectionId={sel} kind="tool" name={tool} params={args}
                    warn={pickedWorst ? `The scan flagged this tool (${pickedWorst}). Read its findings above before you send.` : null} />
                )}
              </>
            )}
          </div>

          <details className="card">
            <summary>Other protocol methods (resources, prompts, completion, logging)</summary>
            <div className="fields">
              <label>Method
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {methods.map((m) => <option key={m.method} value={m.method}>{m.method}</option>)}
                </select>
              </label>
              {methodDef && <p className="small muted">{methodDef.description}</p>}
              <label>Params (JSON object)<textarea rows={3} value={paramsText} onChange={(e) => setParamsText(e.target.value)} spellCheck={false} /></label>
            </div>
            {params === null ? <p className="alert">Params must be a JSON object.</p> : <ConfirmCall connectionId={sel} kind="rpc" name={method} params={params} />}
          </details>
        </>
      )}
    </>
  );
}
