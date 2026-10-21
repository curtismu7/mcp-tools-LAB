import React, { useCallback, useEffect, useState } from "react";
import { del, get, post } from "../lib/api.js";
import { Untrusted } from "../lib/Untrusted.jsx";

const blankForm = { label: "", transport: "http", url: "", authHeader: "Authorization", token: "", command: "", args: "", env: "" };

function parseEnv(text) {
  return Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)]));
}

function ConnectForm({ config, onCreated, onGo }) {
  const [f, setF] = useState(blankForm);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
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
    setCreated(r.data.test.ok ? r.data.connection : null);
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
      {created && <button type="button" className="btn primary" onClick={() => onGo(created)}>Open server now</button>}
    </form>
  );
}


// Saved connections, add a Streamable HTTP or stdio connection, test it, then Open it. A token is write-only: the form
// clears after saving and a saved connection only ever shows "token set".
export default function Connect({ config, activeId, onOpen, onRemoved }) {
  const [conns, setConns] = useState([]);
  const [tests, setTests] = useState({});
  const [busyId, setBusyId] = useState(null);
  const load = useCallback(async () => { const r = await get("/api/connections"); setConns(r.data?.connections || []); }, []);
  useEffect(() => { load(); }, [load]);

  async function test(c) {
    setBusyId(c.id);
    const r = await post(`/api/connections/${encodeURIComponent(c.id)}/test`);
    setBusyId(null);
    const t = r.data?.test;
    setTests((p) => ({ ...p, [c.id]: r.ok && t?.ok ? { ok: true, text: `Connected: ${t.serverInfo?.name || "server"} ${t.serverInfo?.version || ""} (protocol ${t.protocolVersion}).` } : { ok: false, text: `Test failed: ${t?.error || r.data?.message || r.status}` } }));
  }

  return (
    <>
      <h2>Connect to an MCP server</h2>
      <p className="lede">Connect, then Open the server to see what it offers. Connecting sends only an initialize request. Nothing is scanned or called until you say so.</p>
      <h3>Saved connections</h3>
      <div className="card">
        {conns.length === 0 ? <p className="muted">No saved connections yet.</p> : (
          <ul className="conn-list">
            {conns.map((c) => (
              <li key={c.id}>
                <span className="conn-name">
                  <strong><Untrusted text={c.label} /></strong>{" "}
                  <span className="muted small">{c.transport}{c.transport === "http" ? " " : ""}{c.transport === "http" && <Untrusted text={c.url} />} · token {c.token === "set" ? "set" : "not set"}</span>
                  {tests[c.id] && <span className={`small ${tests[c.id].ok ? "okt" : "badt"}`} role="status"> <Untrusted text={tests[c.id].text} /></span>}
                </span>
                <button type="button" className={activeId === c.id ? "btn primary" : "btn"} onClick={() => onOpen(c)} aria-label={`Open ${c.label}`}>Open</button>
                <button type="button" className="btn" onClick={() => test(c)} disabled={busyId === c.id} aria-label={`Test ${c.label}`}>{busyId === c.id ? "Testing..." : "Test"}</button>
                <button type="button" className="btn" aria-label={`Remove ${c.label}`} onClick={async () => { await del(`/api/connections/${encodeURIComponent(c.id)}`); onRemoved(c.id); load(); }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConnectForm config={config} onCreated={(c) => { load(); onOpen(c, false); }} onGo={(c) => onOpen(c, true)} />
    </>
  );
}
