import React, { useCallback, useEffect, useState } from "react";
import { del, get, post, pretty } from "../lib/api.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import "./Proxy.css";

// Live proxy: point an MCP client at this tool and watch what it really sends. The flow log is polled while this page
// is open. Everything in a flow came from an agent or a server, so it is rendered as inert text only.
const POLL_MS = 1500;
const time = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return ""; } };
const slug = (label) => String(label || "server").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "server";
export const clientCommand = (origin, route, token) => `claude mcp add --transport http ${slug(route.label)}-via-proxy ${origin}${route.path} --header "Authorization: Bearer ${token}"`;

function Body({ body }) {
  if (!body || (!body.json && !body.sse && !body.text)) return <p className="muted small">No body.</p>;
  const text = body.json !== undefined ? pretty(body.json) : body.sse ? pretty(body.sse) : body.text;
  return (
    <>
      <p className="muted small">{body.bytes} bytes, ~{body.tokens} tokens{body.sse ? ", server-sent events" : ""}{body.truncated ? ", only the first 64 KB kept" : ""}</p>
      <div className="proxy__pre"><Untrusted text={text} block /></div>
    </>
  );
}
const Headers = ({ headers }) => (
  <dl className="proxy__kv">{Object.entries(headers || {}).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd><Untrusted text={v} /></dd></React.Fragment>)}</dl>
);

export default function Proxy({ modeSource }) {
  const [info, setInfo] = useState(null);
  const [flows, setFlows] = useState([]);
  const [open, setOpen] = useState(null); // full record of the selected flow
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => { const r = await get("/api/proxy"); if (r.ok) setInfo(r.data); else setErr(r.data?.message || `Could not read the proxy state (${r.status}).`); }, []);
  const poll = useCallback(async () => { const r = await get("/api/proxy/flows"); if (r.ok) setFlows(r.data.flows || []); }, []);
  useEffect(() => { load(); }, [load, modeSource]); // the routes change with the Mock/Real toggle
  useEffect(() => { poll(); const t = setInterval(poll, POLL_MS); return () => clearInterval(t); }, [poll]);

  async function toggle() {
    setErr(null);
    const r = await post("/api/proxy", { enabled: !info?.enabled });
    if (r.ok) setInfo(r.data); else setErr(r.data?.message || `Refused (${r.status}).`);
  }
  async function clear() { await del("/api/proxy/flows"); setOpen(null); poll(); }
  async function show(id) { setSaveNote(""); const r = await get(`/api/proxy/flows/${id}`); if (r.ok) setOpen(r.data.flow); else setErr(r.data?.message || "That flow is gone."); }
  // A captured tools/call can become a saved input of that connection (fixtures are not saved connections).
  const callOf = (f) => { const j = f?.request?.body?.json; return f?.rpcMethod === "tools/call" && !f.request.body.truncated && j?.params && typeof j.params.name === "string" ? j.params : null; };
  const savable = (f) => info?.routes?.some((r) => r.id === f.route && r.transport !== "mock");
  const [saveNote, setSaveNote] = useState("");
  async function saveFlow(f) {
    const p = callOf(f);
    const r = await post(`/api/connections/${encodeURIComponent(f.route)}/inputs`, { tool: p.name, name: `from flow #${f.id}`, arguments: p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments) ? p.arguments : {}, source: "flow" });
    setSaveNote(r.ok ? `Saved as "${r.data.input.name}" for ${p.name}. Open the server on the Server page to load it into the call form.` : r.data?.message || `Could not save (${r.status}).`);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setCopied(""); }
  }

  const origin = window.location.origin;
  return (
    <>
      <h2>Live proxy</h2>
      <p className="lede">Point an MCP client (Claude Code, Cursor, ...) at this tool instead of at the server, and see every JSON-RPC message it sends and gets back, with timing and an estimated token cost. It is a local debugging passthrough, not a gateway: it enforces no policy, and the confirm step of the Server page does <strong>not</strong> apply to calls the agent makes through it.</p>

      <div className="card" data-testid="proxy-control">
        <div className="controls">
          <button type="button" className={info?.enabled ? "btn" : "btn primary"} onClick={toggle} disabled={!info} data-testid="proxy-toggle">{info?.enabled ? "Turn the proxy off" : "Turn the proxy on"}</button>
          <span className={info?.enabled ? "okt" : "muted"} role="status" data-testid="proxy-state">{info ? (info.enabled ? "On: listening on this tool's own port, loopback only" : "Off: every proxied request is refused") : "..."}</span>
        </div>
        {err && <p className="alert" role="alert">{err}</p>}
        {info?.enabled && (
          <>
            <p className="small">Proxy token for this session: <code data-testid="proxy-token">{info.token}</code>. Clients send it as <code>Authorization: Bearer ...</code>. It is a local key made by this tool, not a server credential; turning the proxy off, Reset or a restart ends it. The server's own credential stays in the saved connection and is never shown or logged.</p>
            <ul className="proxy__routes" data-testid="proxy-routes">
              {info.routes.map((r) => {
                const cmd = clientCommand(origin, r, info.token);
                return (
                  <li key={r.id}>
                    <strong><Untrusted text={r.label} /></strong> <span className="muted small">{r.transport === "http" ? "passthrough" : "bridged"}</span>
                    <pre className="proxy__pre proxy__cmd">{cmd}</pre>
                    <button type="button" className="btn" onClick={() => copy(cmd, r.id)}>{copied === r.id ? "Copied" : "Copy the Claude Code command"}</button>
                  </li>
                );
              })}
            </ul>
            <p className="muted small">{modeSource === "real" ? "Real: your saved servers are listed with the two samples." : "Mock: only the two built-in sample servers, answered in this process. Switch the header toggle to Real to proxy your saved servers."}</p>
          </>
        )}
      </div>

      <div className="card" data-testid="proxy-flows">
        <div className="controls">
          <h3>Live flow</h3>
          <span className="muted small">last {info?.maxFlows || 200}, in memory only; tokens are an {info?.tokenMethod || "estimate"}</span>
          <button type="button" className="btn" onClick={clear} disabled={!flows.length}>Clear</button>
        </div>
        {!flows.length ? <p className="muted">No traffic yet. Connect a client with a command above, then use it.</p> : (
          <div className="proxy__scroll">
            <table className="proxy__table">
              <thead><tr><th>Time</th><th>Route</th><th>Method</th><th>Status</th><th>ms</th><th>~tokens in / out</th></tr></thead>
              <tbody>
                {[...flows].reverse().map((f) => (
                  <tr key={f.id} aria-selected={open?.id === f.id} data-testid="flow-row">
                    <td>{time(f.at)}</td>
                    <td><Untrusted text={f.routeLabel} /></td>
                    <td><button type="button" className="btn" onClick={() => show(f.id)}><Untrusted text={f.rpcMethod || f.httpMethod} /></button></td>
                    <td className={f.open ? "muted" : f.status >= 400 || f.error ? "badt" : "okt"}>{f.open ? "open" : f.status}</td>
                    <td>{f.ms ?? ""}</td>
                    <td>{f.requestTokens} / {f.responseTokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <div className="card" data-testid="flow-detail">
          <div className="controls">
            <h3><Untrusted text={open.rpcMethod || open.httpMethod} /> <span className="muted small">#{open.id}, {open.via}, {open.status ?? "open"}, {open.ms ?? "?"} ms</span></h3>
            <button type="button" className="btn" onClick={() => setOpen(null)}>Close</button>
          </div>
          {open.error && <p className="alert" role="alert"><Untrusted text={open.error} /></p>}
          {callOf(open) && (
            <div className="controls">
              <button type="button" className="btn" onClick={() => saveFlow(open)} disabled={!savable(open)} title={savable(open) ? undefined : "Only calls to a saved connection (Real mode) can be saved as inputs."} data-testid="save-flow">Save as input</button>
              {!savable(open) && <span className="muted small">Only calls to a saved connection (Real mode) can be saved as inputs.</span>}
              {saveNote && <span className="small" role="status"><Untrusted text={saveNote} /></span>}
            </div>
          )}
          <div className="proxy__cols">
            <section><h4>Request</h4><Headers headers={open.request?.headers} /><Body body={open.request?.body} /></section>
            <section><h4>Response</h4>{open.response ? <><Headers headers={open.response.headers} /><Body body={open.response.body} /></> : <p className="muted small">No response yet.</p>}</section>
          </div>
        </div>
      )}
    </>
  );
}
