import React, { useEffect, useRef } from "react";
import FloatingDialog from "../floating-dialog/FloatingDialog";

// A modal confirm in the shared FloatingDialog (movable, resizable, pop-out). Focus starts on Cancel (so Enter never sends by
// accident), Tab stays inside, Escape cancels, and focus returns to whatever opened it (the last two are FloatingDialog's). The
// caller shows the exact arguments as children and supplies the explicit Send button.
export default function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, busy }) {
  const cancel = useRef(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  // Escape from inside the content cancels here and goes no further (as before: presenter mode's Escape is not triggered too).
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
  }
  return (
    <FloatingDialog isOpen onClose={onCancel} title={title} testId="confirm-dialog" footer={null}
      defaultWidth={576} defaultHeight={null} minHeight={200}>
      <div onKeyDown={onKey}>
        {children}
        <div className="modal__actions">
          <button ref={cancel} type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" onClick={onConfirm} disabled={busy}>{busy ? "Sending..." : confirmLabel}</button>
        </div>
      </div>
    </FloatingDialog>
  );
}
