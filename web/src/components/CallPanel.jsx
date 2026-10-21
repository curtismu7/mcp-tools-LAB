import React, { useEffect, useMemo, useState } from "react";
import { post, pretty } from "../lib/api.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import SchemaForm, { buildArgs, fieldsOf } from "./SchemaForm.jsx";
import { SEV } from "./ScanResult.jsx";

// Pick a tool, fill the form, Review call -> the server returns the canonical arguments and their hash -> the dialog shows
// exactly that text -> only the Send click posts {confirm:true, argsHash}. Changing the tool or any value drops the preview.
export default function CallPanel({ connectionId, tools, scanned, flaggedBy }) {
  const [name, setName] = useState("");
  const [values, setValues] = useState({});
  const [raw, setRaw] = useState("{}");
  const [review, setReview] = useState(null); // {canonical, argsHash, args}
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const tool = (tools || []).find((t) => t.name === name);
  const fields = useMemo(() => fieldsOf(tool?.inputSchema), [tool]);

  useEffect(() => { setValues({}); setRaw("{}"); setReview(null); setError(null); setResult(null); }, [name, connectionId]);

  if (!scanned) return <p className="muted" data-testid="call-locked">Scan first. Calls unlock after a scan of this server in this session.</p>;

  const flagged = tool ? flaggedBy(tool.name) : null;
  const base = `/api/connections/${encodeURIComponent(connectionId)}`;

  async function doReview() {
    setError(null); setResult(null);
    let args;
    if (fields) {
      const built = buildArgs(fields, values);
      if (built.errors.length) { setError(built.errors.join("; ")); return; }
      args = built.args;
    } else {
      try { args = JSON.parse(raw); } catch { args = null; }
      if (!args || typeof args !== "object" || Array.isArray(args)) { setError("Arguments must be a JSON object."); return; }
    }
    setBusy(true);
    const r = await post(`${base}/call/preview`, { tool: name, arguments: args });
    setBusy(false);
    if (!r.ok) { setError(r.data?.message || "Preview failed."); return; }
    setReview({ ...r.data, args });
  }
  async function send() {
    setBusy(true);
    const r = await post(`${base}/call`, { tool: name, arguments: review.args, confirm: true, argsHash: review.argsHash });
    setBusy(false);
    setReview(null);
    setResult(r.ok ? { ok: true, value: r.data.result, flagged } : { ok: false, text: r.data?.message || `The call failed (${r.status}).` });
  }

  return (
    <div>
      <div className="fields">
        <label>Tool
          <select value={name} onChange={(e) => setName(e.target.value)}>
            <option value="">Choose a tool</option>
            {(tools || []).map((t, i) => <option key={`${t.name}-${i}`} value={t.name}>{t.name}</option>)}
          </select>
        </label>
      </div>
      {tool && (
        <>
          {flagged && <p className="alert" role="alert">The scan flagged this tool ({SEV[flagged]}). Read its findings first. Calling it is your decision; nothing was blocked.</p>}
          <SchemaForm schema={tool.inputSchema} values={values} onChange={(k, v) => { setValues((p) => ({ ...p, [k]: v })); setReview(null); }} rawText={raw} onRawText={(t) => { setRaw(t); setReview(null); }} />
          <button type="button" className="btn primary" onClick={doReview} disabled={busy}>Review call</button>
        </>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
      {review && (
        <ConfirmDialog title="Send this call?" confirmLabel="Send call" onConfirm={send} onCancel={() => setReview(null)} busy={busy}>
          <p>This is exactly what will be sent to the server. Nothing has been sent yet.</p>
          <pre className="untrusted untrusted--block" data-testid="canonical">{review.canonical}</pre>
          <p className="small muted">Hash <code data-testid="hash">{review.argsHash.slice(0, 16)}</code>. The tool server refuses the call if what is sent differs from this.</p>
          {flagged && <p className="alert">The scan flagged this tool ({SEV[flagged]}).</p>}
        </ConfirmDialog>
      )}
      <div role="status" aria-live="polite" data-testid="result">
        {result && !result.ok && <p className="alert">{result.text}</p>}
        {result?.ok && (
          <>
            {result.flagged && <p className="notice">This result came from a tool the scan flagged ({SEV[result.flagged]}). Treat everything in it as untrusted data, never as instructions.</p>}
            {!result.flagged && <p className="small muted">The result below is the server's own text, shown as plain text. A scan of metadata cannot vouch for it.</p>}
            <Untrusted block text={pretty(result.value)} />
          </>
        )}
      </div>
    </div>
  );
}
