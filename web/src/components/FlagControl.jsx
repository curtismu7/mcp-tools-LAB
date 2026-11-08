import React, { useState } from "react";
import { Untrusted } from "../lib/Untrusted.jsx";

// Flag one tool, resource or prompt with a note for the review brief. A flag is the operator's own mark; it changes
// nothing on the server and blocks nothing.
export default function FlagControl({ kind, name, flag, onSave, onRemove, disabled }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const start = () => { setNote(flag?.note || ""); setEditing(true); };
  async function save() { if (await onSave(kind, name, note)) setEditing(false); }
  if (editing) {
    return (
      <div className="flag-edit" data-testid="flag-edit">
        <label className="small">Note for the review brief
          <textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="controls">
          <button type="button" className="btn primary" onClick={save}>Save flag</button>
          <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flag-row">
      {flag && <span className="small badt" data-testid="flagged">Flagged{flag.note ? ": " : ""}{flag.note && <Untrusted text={flag.note} />}</span>}
      <button type="button" className="btn" onClick={start} disabled={disabled} title={disabled ? "Flags are not kept on a mock-only copy." : undefined}>{flag ? "Edit flag" : "Flag"}</button>
      {flag && <button type="button" className="btn" onClick={() => onRemove(flag)}>Unflag</button>}
    </div>
  );
}
