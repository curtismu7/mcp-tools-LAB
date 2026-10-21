import React, { useEffect, useState } from "react";
import { post, pretty } from "../lib/api.js";
import { Untrusted } from "../lib/Untrusted.jsx";

// The confirm step. 1) Preview asks the server for the canonical arguments and their hash. 2) The operator reads exactly
// that text and ticks the box. 3) Send posts {confirm:true, argsHash}. Changing anything resets to step 1.
// `kind` is "tool" (tools/call) or "rpc" (a protocol method).
export default function ConfirmCall({ connectionId, kind, name, params, warn }) {
  const [preview, setPreview] = useState(null);
  const [seen, setSeen] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = `${connectionId}|${kind}|${name}|${JSON.stringify(params)}`;
  useEffect(() => { setPreview(null); setSeen(false); setResult(null); }, [key]);

  const base = `/api/connections/${encodeURIComponent(connectionId)}`;
  const body = kind === "tool" ? { tool: name, arguments: params } : { method: name, params };

  async function doPreview() {
    setBusy(true);
    const r = await post(`${base}/${kind === "tool" ? "call/preview" : "rpc/preview"}`, body);
    setBusy(false);
    setResult(r.ok ? null : { error: r.data?.message || "preview failed" });
    setPreview(r.ok ? r.data : null);
  }
  async function send() {
    setBusy(true);
    const r = await post(`${base}/${kind === "tool" ? "call" : "rpc"}`, { ...body, confirm: true, argsHash: preview.argsHash });
    setBusy(false);
    setResult(r.ok ? r.data : { error: r.data?.message || `failed (${r.status})` });
  }

  return (
    <div className="confirm">
      <button type="button" className="btn" onClick={doPreview} disabled={busy || !name}>Preview call</button>
      {preview && (
        <div className="card inner" data-testid="preview">
          <h4>Exactly what will be sent</h4>
          <pre className="untrusted untrusted--block" data-testid="canonical">{preview.canonical}</pre>
          <p className="small muted">Hash <code data-testid="hash">{preview.argsHash.slice(0, 16)}</code>. The server refuses the call if what is sent differs from this.</p>
          {warn && <p className="alert" role="alert">{warn}</p>}
          <label className="check">
            <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} /> I read these exact arguments and want to send this call to the server.
          </label>
          <button type="button" className="btn primary" onClick={send} disabled={busy || !seen}>Send call</button>
        </div>
      )}
      {result && (
        <div className="result" role="status" aria-live="polite" data-testid="result">
          {result.error ? <p className="alert">{result.error}</p> : <Untrusted block text={pretty(result.result)} />}
        </div>
      )}
    </div>
  );
}
