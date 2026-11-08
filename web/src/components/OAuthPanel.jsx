import React, { useCallback, useEffect, useRef, useState } from "react";
import { get, post } from "../lib/api.js";
import { Untrusted } from "../lib/Untrusted.jsx";
import SignInModal from "./SignInModal.jsx";

// OAuth sign-in for an MCP server: our PingOne by pi.flow (the standard Sign in dialog), a third-party server by a
// browser sign-in in a new tab (a rule-16 exception). Any other Ping server is refused.
// Shown only when the server asks for a token. The sign-in opens in a new tab; this panel waits for it to finish.
// No token is ever shown: the server keeps it in memory.
const POLL_MS = 2000;
const WAIT_MS = 5 * 60 * 1000;

export default function OAuthPanel({ conn, onSignedIn, recheck = 0 }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [clientId, setClientId] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [modal, setModal] = useState(false);
  const timer = useRef(null);
  const cardRef = useRef(null);
  const base = `/api/connections/${encodeURIComponent(conn.id)}/oauth`;

  const load = useCallback(async () => {
    const r = await get(base);
    if (r.ok) { setS(r.data); setErr(""); return r.data; }
    // Only an OAuth discovery problem belongs here; an unreachable server is reported by the tool list already.
    const code = String(r.data?.error || "");
    setS(null); setErr(code.startsWith("oauth_") && code !== "oauth_unreachable" ? r.data?.message || "" : "");
    return null;
  }, [base]);
  useEffect(() => { load(); return () => clearInterval(timer.current); }, [load, recheck]); // recheck: a call was refused with a 401, so ask again whether the server wants a token

  async function signIn() {
    setErr("");
    const r = await post(`${base}/start`, clientId.trim() ? { clientId: clientId.trim() } : {});
    if (!r.ok) { setErr(r.data?.message || `Could not start the sign-in (${r.status}).`); return; }
    window.open(r.data.authorizeUrl, "_blank", "noopener,noreferrer");
    setWaiting(true);
    const until = Date.now() + WAIT_MS;
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const now = await load();
      if (now?.signedIn) { clearInterval(timer.current); setWaiting(false); onSignedIn?.(); }
      else if (Date.now() > until) { clearInterval(timer.current); setWaiting(false); setErr("The sign-in did not finish in 5 minutes. Start it again."); }
    }, POLL_MS);
  }
  async function signOut() { await post(`${base}/signout`); clearInterval(timer.current); setWaiting(false); load(); }

  // After a refused call (recheck > 0) the card may be off screen: bring it into view once it shows up.
  const showing = Boolean((s && s.required) || err);
  useEffect(() => { if (recheck > 0 && showing) cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }, [recheck, showing]);
  if (!s && !err) return null;
  if (s && !s.required) return null;
  return (
    <div className="card" data-testid="oauth" ref={cardRef}>
      <h3>OAuth sign-in</h3>
      {err && <p className="alert" role="alert"><Untrusted text={err} /></p>}
      {s?.refused && <p className="notice" role="note"><Untrusted text={s.refused} /></p>}
      {s && !s.refused && (
        <>
          <p className="small">This server asks for a token. Authorization server: <code><Untrusted text={s.issuer || "?"} /></code>{s.scopes?.length ? <> · scopes <code><Untrusted text={s.scopes.join(" ")} /></code></> : null}.</p>
          {s.signedIn ? (
            <div className="controls">
              <span className="okt" role="status" data-testid="oauth-state">Signed in{s.expiresAt ? `, token renews before ${new Date(s.expiresAt).toLocaleTimeString()}` : ""}{s.canRefresh ? "" : " (no refresh: sign in again when it expires)"}</span>
              <button type="button" className="btn" onClick={signOut}>Sign out</button>
            </div>
          ) : s.method === "piflow" ? (
            <>
              <div className="controls">
                <button type="button" className="btn primary" onClick={() => setModal(true)} disabled={modal}>Sign in with PingOne</button>
                <span className="muted small" data-testid="oauth-state">Not signed in. This server uses our PingOne environment: pi.flow sign-in, no redirect.</span>
              </div>
              {modal && <SignInModal startUrl={`${base}/piflow`} credentialsUrl={`${base}/piflow/credentials`} onClose={() => setModal(false)} onDone={() => { setModal(false); load().then(() => onSignedIn?.()); }} />}
            </>
          ) : (
            <>
              {!s.dynamicRegistration && (
                <label className="small">Client id registered with that server (redirect URI <code>{s.redirectUri}</code>)
                  <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
                </label>
              )}
              <div className="controls">
                <button type="button" className="btn primary" onClick={signIn} disabled={waiting || (!s.dynamicRegistration && !clientId.trim())}>{waiting ? "Waiting for the sign-in tab..." : "Sign in (opens a new tab)"}</button>
                <span className="muted small" data-testid="oauth-state">{waiting ? "Finish the sign-in in the other tab; this page picks it up." : "Not signed in."}</span>
              </div>
              <p className="muted small">A browser sign-in is a recorded exception to this family's pi.flow-only rule, for third-party servers only. The token stays in this tool's memory: never shown, never written to disk, gone on restart.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
