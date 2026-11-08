import React, { useEffect, useRef, useState } from "react";
import { post } from "../lib/api.js";
import "./SignInModal.css";

// The family's standard pi.flow Sign in dialog (owner 2026-10-30): titled "Sign in", draggable by its title bar,
// NON-blocking (no backdrop, no focus trap), Escape and Cancel close it, Sign in is disabled until both fields are set,
// the password field is uncontrolled and cleared after each try, a ❌ error line. Shape copied from the family's copies
// (id-jag-standalone SignInModal, the labs' Credentials view), not imported. The username and password go to this
// tool only; this tool drives PingOne's flows API (pi.flow), so the browser is never redirected.
//   startUrl: POST, returns {run, state, status}; credentialsUrl: POST {run, username, password}.
export default function SignInModal({ startUrl, credentialsUrl, onDone, onClose }) {
  const [run, setRun] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(true);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pass = useRef(null);
  const user = useRef(null);
  const drag = useRef(null);

  const describe = (d) => (d?.state === "stopped" ? `PingOne stopped at ${d.status}: a step this sign-in cannot show (for example MFA). Use an account with a password-only policy.` : d?.message || "Sign-in did not complete. Close this and try again.");
  useEffect(() => {
    let live = true;
    post(startUrl, {}).then((r) => {
      if (!live) return;
      setBusy(false);
      if (r.ok && r.data?.state === "signed_in") { onDone(); return; } // an existing PingOne session
      if (r.ok && r.data?.state === "credentials_required") { setRun(r.data.run); setTimeout(() => user.current?.focus(), 0); return; }
      setNotice(describe(r.ok ? r.data : r.data));
    }).catch(() => live && (setBusy(false), setNotice("Could not reach this tool. Close this and try again.")));
    return () => { live = false; };
  }, [startUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    const password = pass.current?.value || "";
    if (!username || !password || busy) return;
    if (pass.current) pass.current.value = "";
    setHasPassword(false); setError(""); setBusy(true);
    const r = await post(credentialsUrl, { run, username, password });
    setBusy(false);
    if (r.ok && r.data?.state === "signed_in") { onDone(); return; }
    if (r.ok && r.data?.state === "credentials_required") { setError(r.data.refused || "Username or password is incorrect."); pass.current?.focus(); return; }
    setRun(null); setNotice(describe(r.data));
  }

  const onDown = (e) => { drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => { if (drag.current) setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); };
  const onUp = () => { drag.current = null; };

  return (
    <div className="signin-dialog" role="dialog" aria-labelledby="signin-title" data-testid="signin-dialog" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
      <h2 id="signin-title" className="signin-title" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>Sign in</h2>
      <p className="small muted">PingOne, by pi.flow: your password goes to this tool once, which passes it to PingOne. It is never stored.</p>
      {notice ? (
        <>
          <p className="signin-error" role="alert">❌ {notice}</p>
          <div className="signin-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="signin-user">Username</label>
          <input id="signin-user" ref={user} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" maxLength={256} disabled={!run} />
          <label htmlFor="signin-pass">Password</label>
          <input id="signin-pass" ref={pass} type="password" onChange={(e) => setHasPassword(Boolean(e.target.value))} autoComplete="current-password" maxLength={1024} disabled={!run} />
          {error && <p className="signin-error" role="alert">❌ {error}</p>}
          <div className="signin-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!run || busy || !username || !hasPassword}>{busy ? "Signing in..." : "Sign in"}</button>
          </div>
        </form>
      )}
    </div>
  );
}
