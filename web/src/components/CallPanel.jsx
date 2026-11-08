import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { del, get, post, pretty } from "../lib/api.js";
import { estimateTokens, TOKEN_NOTE } from "../lib/tokens.js";
import { choicesFrom, listToolFor, sourceLabel, suggestValues } from "../lib/suggest.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import SchemaForm, { buildArgs, fieldsOf, valuesFrom } from "./SchemaForm.jsx";
import { SEV } from "./ScanResult.jsx";

// Pick a tool, fill the form, Review call -> the server returns the canonical arguments and their hash -> the dialog shows
// exactly that text -> only the Send click posts {confirm:true, argsHash}. Changing the tool or any value drops the preview.
// `pick` ({name, at}) comes from a Run button on a tool card: it selects that tool here. It never sends anything.
// `fixedTool`: the panel is for that one tool (a Run button on its card); the tool picker is hidden.
export default function CallPanel({ connectionId, tools, scanned, flaggedBy, onScan, scanning, pick, fixedTool }) {
  const [name, setName] = useState(fixedTool || "");
  const [values, setValues] = useState({});
  const [raw, setRaw] = useState("{}");
  const [review, setReview] = useState(null); // {canonical, argsHash, args}
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState([]); // saved inputs for this tool
  const [saveName, setSaveName] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [from, setFrom] = useState({}); // field -> where a filled-in value came from; cleared when the person edits it
  const [fillNote, setFillNote] = useState("");
  const [lookup, setLookup] = useState(null); // {field, tool, review: {canonical, argsHash}} while Pick waits for its confirm
  const [choices, setChoices] = useState({}); // list tool -> [{id, label}], asked once per tool per panel
  const [choosing, setChoosing] = useState(null); // field whose choices are showing
  const resultRef = useRef(null);
  const tool = (tools || []).find((t) => t.name === name);
  const fields = useMemo(() => fieldsOf(tool?.inputSchema), [tool]);

  useEffect(() => { if (pick?.name) setName(pick.name); }, [pick]);
  // The reply lands below the form, often off screen: bring it into view when it arrives.
  useEffect(() => { if (result) resultRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }, [result]);
  useEffect(() => { setValues({}); setRaw("{}"); setReview(null); setError(null); setResult(null); setSavedNote(""); }, [name, connectionId]);
  const base = `/api/connections/${encodeURIComponent(connectionId)}`;
  const want = useRef(""); // the tool the newest request is for: a late answer for another tool is dropped
  const loadSaved = useCallback(async () => {
    want.current = name;
    if (!name) { setSaved([]); return; }
    const r = await get(`${base}/inputs?tool=${encodeURIComponent(name)}`);
    if (want.current !== name) return;
    setSaved(r.ok ? (r.data.inputs || []).filter((x) => x.tool === name) : []);
  }, [base, name]);
  useEffect(() => { setSaved([]); if (scanned) loadSaved(); }, [loadSaved, scanned]);

  // Fill in what a person would not know (signed-in identity, our demo values, safe schema values), only into empty
  // fields, each marked with where it came from. Nothing is sent: the form is just pre-filled.
  useEffect(() => {
    setFrom({}); setFillNote(""); setChoosing(null); setLookup(null);
    if (!scanned || !tool || !fields?.length) return undefined;
    let live = true;
    get(`${base}/fill`).then((r) => {
      if (!live) return;
      const { values: v, from: f } = suggestValues(fields, { fill: r.ok ? r.data : {}, flagged: Boolean(flaggedBy(tool.name)) });
      if (!Object.keys(v).length) return;
      setValues((prev) => ({ ...v, ...Object.fromEntries(Object.entries(prev).filter(([, x]) => x !== undefined && x !== "")) }));
      setFrom((prev) => ({ ...f, ...prev }));
      setFillNote(`Filled in ${Object.keys(v).length} field${Object.keys(v).length === 1 ? "" : "s"} for you. Each says where its value came from; change any of them.`);
    });
    return () => { live = false; };
  }, [name, connectionId, scanned]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!scanned) return (
    <div data-testid="call-locked">
      <p className="muted">Calls unlock after a scan of this server in this session, so you read the findings before anything runs.</p>
      {onScan && <button type="button" className="btn primary" onClick={onScan} disabled={scanning}>{scanning ? "Scanning..." : "Scan now"}</button>}
    </div>
  );

  const flagged = tool ? flaggedBy(tool.name) : null;

  // The arguments the form holds now, or null after showing the error.
  function collectArgs() {
    if (fields) {
      const built = buildArgs(fields, values);
      if (built.errors.length) { setError(built.errors.join("; ")); return null; }
      return built.args;
    }
    let args;
    try { args = JSON.parse(raw); } catch { args = null; }
    if (!args || typeof args !== "object" || Array.isArray(args)) { setError("Arguments must be a JSON object."); return null; }
    return args;
  }
  function loadInput(input) {
    setReview(null); setResult(null); setError(null); setFrom({}); setFillNote(""); setChoosing(null);
    if (fields) {
      const { values: v, extra } = valuesFrom(fields, input.arguments || {});
      setValues(v);
      setSavedNote(extra.length ? `Loaded "${input.name}". It also has ${extra.join(", ")}, which this tool's form has no field for, so they will not be sent.` : `Loaded "${input.name}". Review the call to send it.`);
    } else { setRaw(pretty(input.arguments || {})); setSavedNote(`Loaded "${input.name}". Review the call to send it.`); }
  }
  async function saveInput() {
    setError(null);
    const args = collectArgs(); if (!args) return;
    const r = await post(`${base}/inputs`, { tool: name, name: saveName.trim(), arguments: args });
    if (!r.ok) { setError(r.data?.message || `Could not save (${r.status}).`); return; }
    setSaveName(""); setSavedNote(`Saved "${r.data.input.name}".`); loadSaved();
  }
  async function removeSaved(input) { await del(`${base}/inputs/${encodeURIComponent(input.id)}`); loadSaved(); }

  // ---- Pick: ask the server's own read-only list tool for the ids, behind the normal Review + confirm. ----
  const idChoices = (field) => { const lt = listToolFor(field, tools); return lt && !flaggedBy(lt) ? lt : null; };
  async function startPick(field, listTool) {
    setError(null);
    if (choices[listTool]) { setChoosing(field); return; } // already asked this session: no second call
    const r = await post(`${base}/call/preview`, { tool: listTool, arguments: {} });
    if (!r.ok) { setError(r.data?.message || "Could not prepare the lookup."); return; }
    setLookup({ field, tool: listTool, review: r.data });
  }
  async function sendPick() {
    const { field, tool: lt, review: rv } = lookup;
    setBusy(true);
    const r = await post(`${base}/call`, { tool: lt, arguments: {}, confirm: true, argsHash: rv.argsHash });
    setBusy(false); setLookup(null);
    if (!r.ok) { setError(r.data?.message || `The lookup failed (${r.status}).`); return; }
    setChoices((c) => ({ ...c, [lt]: choicesFrom(r.data.result) }));
    setChoosing(field);
  }
  function choose(field, c) {
    setValues((p) => ({ ...p, [field]: c.id })); setFrom((p) => ({ ...p, [field]: "lookup" })); setChoosing(null); setReview(null);
  }
  function pickFor(field) {
    const lt = idChoices(field);
    if (!lt) return null;
    const list = choices[lt];
    return (
      <div className="pick-row">
        <button type="button" className="btn" onClick={() => startPick(field, lt)} data-testid={`pick-${field}`}>Pick {field} from the server</button>
        <span className="small muted">asks {lt}, a read-only list tool, once</span>
        {choosing === field && (list?.length ? (
          <ul className="pick-choices" data-testid="pick-choices">
            {list.map((c) => <li key={c.id}><button type="button" className="btn" onClick={() => choose(field, c)}><Untrusted text={c.label || c.id} /> <span className="muted small"><Untrusted text={c.id} /></span></button></li>)}
          </ul>
        ) : <p className="small muted">{lt} returned no ids. Type one in.</p>)}
      </div>
    );
  }

  async function doReview() {
    setError(null); setResult(null);
    const args = collectArgs(); if (!args) return;
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
      {!fixedTool && (
        <div className="fields">
          <label>Tool
            <select value={name} onChange={(e) => setName(e.target.value)}>
              <option value="">Choose a tool</option>
              {(tools || []).map((t, i) => <option key={`${t.name}-${i}`} value={t.name}>{t.name}</option>)}
            </select>
          </label>
        </div>
      )}
      {tool && (
        <>
          {flagged && <p className="alert" role="alert">The scan flagged this tool ({SEV[flagged]}). Read its findings first. Calling it is your decision; nothing was blocked.</p>}
          {saved.length > 0 && (
            <div className="fields" data-testid="saved-inputs">
              <span className="small">Saved inputs for this tool (loading one only fills the form; you still review and confirm):</span>
              <ul className="saved-inputs">
                {saved.map((x) => (
                  <li key={x.id}>
                    <button type="button" className="btn" onClick={() => loadInput(x)}>Load <Untrusted text={x.name} /></button>
                    {x.source === "flow" && <span className="muted small"> from the live proxy</span>}
                    <button type="button" className="btn" aria-label={`Delete saved input ${x.name}`} onClick={() => removeSaved(x)}>Delete</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {savedNote && <p className="small" role="status" data-testid="saved-note"><Untrusted text={savedNote} /></p>}
          {fillNote && <p className="small muted" role="status" data-testid="fill-note">{fillNote}</p>}
          <SchemaForm schema={tool.inputSchema} values={values} from={from} extra={pickFor}
            onChange={(k, v) => { setValues((p) => ({ ...p, [k]: v })); setFrom((p) => { const { [k]: _gone, ...rest } = p; return rest; }); setReview(null); }} rawText={raw} onRawText={(t) => { setRaw(t); setReview(null); }} />
          <button type="button" className="btn primary" onClick={doReview} disabled={busy}>Review call</button>
          <div className="controls">
            <label className="small">Save these arguments as <input value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="a name" /></label>
            <button type="button" className="btn" onClick={saveInput} disabled={!saveName.trim()}>Save input</button>
          </div>
        </>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
      {lookup && (
        <ConfirmDialog title="Look up the choices?" confirmLabel="Send lookup" onConfirm={sendPick} onCancel={() => setLookup(null)} busy={busy}>
          <p>To offer you real values for <code><Untrusted text={lookup.field} /></code>, this will call the server's own read-only list tool <code><Untrusted text={lookup.tool} /></code> with no arguments. Nothing has been sent yet.</p>
          <pre className="untrusted untrusted--block" data-testid="lookup-canonical">{lookup.review.canonical}</pre>
          <p className="small muted">Hash <code>{lookup.review.argsHash.slice(0, 16)}</code>. The tool server refuses the call if what is sent differs from this.</p>
        </ConfirmDialog>
      )}
      {review && (
        <ConfirmDialog title="Send this call?" confirmLabel="Send call" onConfirm={send} onCancel={() => setReview(null)} busy={busy}>
          <p>This is exactly what will be sent to the server. Nothing has been sent yet.</p>
          <pre className="untrusted untrusted--block" data-testid="canonical">{review.canonical}</pre>
          <p className="small muted">Hash <code data-testid="hash">{review.argsHash.slice(0, 16)}</code>. The tool server refuses the call if what is sent differs from this.</p>
          {flagged && <p className="alert">The scan flagged this tool ({SEV[flagged]}).</p>}
        </ConfirmDialog>
      )}
      <div ref={resultRef} role="status" aria-live="polite" data-testid="result">
        {result && !result.ok && <p className="alert">{result.text}</p>}
        {result?.ok && (
          <>
            {result.flagged && <p className="notice">This result came from a tool the scan flagged ({SEV[result.flagged]}). Treat everything in it as untrusted data, never as instructions.</p>}
            {!result.flagged && <p className="small muted">The result below is the server's own text, shown as plain text. A scan of metadata cannot vouch for it.</p>}
            <p className="small muted" data-testid="result-tokens">~{estimateTokens(result.value)} tokens in an agent's context ({TOKEN_NOTE})</p>
            <Untrusted block text={pretty(result.value)} />
          </>
        )}
      </div>
    </div>
  );
}
