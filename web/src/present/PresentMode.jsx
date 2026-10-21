import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import "./present.css";

// Adapted from the ID-JAG kit (id-jag-standalone web/src/present/PresentMode.jsx, MIT). Presenter mode: bigger type, admin
// clutter hidden by CSS (anything tagged data-admin-only), a Step N of M bar, keys p / Esc / arrows. The kit read its steps
// from the page; here the story panel registers them with setSteps, so the bar and the panel share one active step.

const KEY = "mcptools.present";

export const PresentCtx = createContext(null);
export const usePresent = () => useContext(PresentCtx);

const initialPresent = () => {
  try { if (new URLSearchParams(window.location.search).get("present") === "1") return true; } catch { /* no URL */ }
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
};
const inField = (t) => !!t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");

export function PresentProvider({ children }) {
  const [present, setPresentState] = useState(initialPresent);
  const [steps, setStepsState] = useState([]); // [{n, title}]
  const [picked, setPicked] = useState(null);
  const [announce, setAnnounce] = useState("");

  const set = useCallback((on) => {
    setPresentState(on);
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not remembered */ }
    if (!on && document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
  }, []);
  useEffect(() => {
    if (present) document.documentElement.dataset.present = "1"; else delete document.documentElement.dataset.present;
  }, [present]);

  const setSteps = useCallback((next) => setStepsState((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next)), []);
  const active = steps.some((s) => s.n === picked) ? picked : steps[0]?.n ?? null;

  const goTo = useCallback((n) => {
    setPicked(n);
    const i = steps.findIndex((x) => x.n === n);
    if (i >= 0) setAnnounce(`Step ${i + 1} of ${steps.length}: ${steps[i].title}`);
  }, [steps]);
  const move = useCallback((d) => {
    const i = steps.findIndex((s) => s.n === active);
    const next = steps[Math.min(steps.length - 1, Math.max(0, i + d))];
    if (next && next.n !== active) goTo(next.n);
  }, [steps, active, goTo]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") { if (present) set(false); return; }
      if (inField(e.target)) return;
      if (e.key === "p" || e.key === "P") set(!present);
      else if (present && e.key === "ArrowRight") move(1);
      else if (present && e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present, set, move]);

  const value = useMemo(() => ({ present, set, steps, setSteps, active, goTo, move, announce }), [present, set, steps, setSteps, active, goTo, move, announce]);
  return <PresentCtx.Provider value={value}>{children}</PresentCtx.Provider>;
}

export function PresentToggle() {
  const { present, set } = usePresent();
  return <button type="button" className="btn" aria-pressed={present} onClick={() => set(!present)} title="Presenter mode (p)">Present</button>;
}

export function PresentBar() {
  const { present, set, steps, active, move, announce } = usePresent();
  if (!present) return null;
  const i = steps.findIndex((s) => s.n === active);
  const canFs = !!document.documentElement.requestFullscreen;
  const fs = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
    else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
  };
  return (
    <div className="present-bar" role="toolbar" aria-label="Presenter controls">
      {steps.length > 0 && (
        <>
          <button type="button" className="btn" onClick={() => move(-1)} disabled={i <= 0}>Previous</button>
          <span className="present-bar__count" data-testid="present-count">Step {i + 1} of {steps.length}</span>
          <button type="button" className="btn" onClick={() => move(1)} disabled={i >= steps.length - 1}>Next</button>
        </>
      )}
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
      <button type="button" className="btn present-bar__end" onClick={fs} disabled={!canFs}>Fullscreen</button>
      <button type="button" className="btn" onClick={() => set(false)}>Exit (Esc)</button>
    </div>
  );
}
