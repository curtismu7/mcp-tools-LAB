import React, { useCallback, useEffect, useState } from "react";
import { del, get, post } from "../lib/api.js";
import { Untrusted } from "../lib/Untrusted.jsx";

const blankForm = { label: "", transport: "http", url: "", authHeader: "Authorization", token: "", command: "", args: "", env: "" };

function parseEnv(text) {
  return Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)]));
}

// Hosted mock: the server accepts only its two built-in sample servers, so there is no URL, token or command to type.
function MockPicker({ onCreated, onGo }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function pick(fixture) {
    setBusy(true);
    const r = await post("/api/connections", { transport: "mock", fixture });
    setBusy(false);
    if (!r.ok) { setMsg(r.data?.message || "Could not connect."); return; }
    setMsg(null);
    onCreated(r.data.connection);
    onGo(r.data.connection);
  }
  return (
    <section className="card" aria-labelledby="mock-h">
      <h3 id="mock-h">Built-in sample servers</h3>
      <p className="small muted">Custom URLs, tokens and stdio commands are disabled in the hosted mock.</p>
      <button type="button" className="btn primary" disabled={busy} onClick={() => pick("sample")}>Open the clean sample server</button>{" "}
      <button type="button" className="btn" disabled={busy} onClick={() => pick("hostile")}>Open the hostile sample server</button>
      {msg && <p className="alert" role="status">{msg}</p>}
    </section>
  );
}

function ConnectForm({ config, onCreated, onGo }) {
  const [f, setF] = useState(blankForm);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  // Our own MCP servers, with whether each is running now. Choosing one fills every field; nothing else needs typing.
  const [known, setKnown] = useState([]);
  const [picked, setPicked] = useState("");
  const loadKnown = useCallback(async () => { const r = await get("/api/known-servers"); setKnown(r.ok ? r.data?.servers || [] : []); }, []);
  useEffect(() => { loadKnown(); }, [loadKnown]);
  const chosen = known.find((s) => s.id === picked);
  function choose(e) {
    const id = e.target.value;
    setPicked(id);
    const k = known.find((s) => s.id === id);
    if (!k) return;
    setF((p) => ({ ...p, transport: "http", label: k.label, url: k.url, authHeader: k.authHeader || "Authorization", token: "" }));
    setMsg(null);
  }

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
      {known.length > 0 && (
        <div className="fields">
          <label>Our servers
            <select value={picked} onChange={choose} onFocus={loadKnown}>
              <option value="">Choose one of our servers...</option>
              {known.map((k) => <option key={k.id} value={k.id}>{k.running ? "Running" : "Not running"} - {k.label}</option>)}
            </select>
          </label>
          {chosen && chosen.running && !chosen.needsToken && <p className="small okt" role="status">Running. Every field is filled in: press Connect and test.</p>}
          {chosen && chosen.running && chosen.needsToken && <p className="small okt" role="status">Running. This one needs a token: paste it into Auth header value (Bearer ...), then press Connect and test.</p>}
          {chosen && !chosen.running && (
            <p className="small badt" role="status">
              Not running yet. Start it, then check again: <code>{chosen.start}</code>{" "}
              <button type="button" className="btn" onClick={loadKnown}>Check again</button>
            </p>
          )}
          {chosen && chosen.note && <p className="small muted">{chosen.note}</p>}
        </div>
      )}
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
        {f.transport === "pingone" && <p className="small muted">Optional, untested here. After connecting, sign in on the Server page (pi.flow: the Sign in dialog, no redirect).</p>}
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
      {config?.mockOnly
        ? <MockPicker onCreated={(c) => { load(); onOpen(c, false); }} onGo={(c) => onOpen(c, true)} />
        : <ConnectForm config={config} onCreated={(c) => { load(); onOpen(c, false); }} onGo={(c) => onOpen(c, true)} />}
    </>
  );
}
