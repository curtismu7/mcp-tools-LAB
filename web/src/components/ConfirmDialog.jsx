import React, { useEffect, useRef } from "react";

// A modal confirm. Focus starts on Cancel (so Enter never sends by accident), Tab stays inside, Escape cancels, and focus
// returns to whatever opened it. The caller shows the exact arguments as children and supplies the explicit Send button.
export default function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, busy }) {
  const box = useRef(null);
  const cancel = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    cancel.current?.focus();
    return () => opener?.focus?.();
  }, []);
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); onCancel(); return; }
    if (e.key !== "Tab") return;
    const f = [...box.current.querySelectorAll("button:not(:disabled), input, select, textarea, a[href]")];
    if (!f.length) return;
    const first = f[0]; const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  return (
    <div className="modal-backdrop" onKeyDown={onKey}>
      <div ref={box} className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-h" data-testid="confirm-dialog">
        <h3 id="confirm-h">{title}</h3>
        {children}
        <div className="modal__actions">
          <button ref={cancel} type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" onClick={onConfirm} disabled={busy}>{busy ? "Sending..." : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
