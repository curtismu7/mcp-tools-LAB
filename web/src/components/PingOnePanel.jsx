import React, { useCallback, useEffect, useState } from "react";
import { get, post } from "../lib/api.js";
import SignInModal from "./SignInModal.jsx";

// The "PingOne hosted" connection (optional, MCPTOOLS_PINGONE=1): sign in to our PingOne by pi.flow before listing.
export default function PingOnePanel({ onSignedIn }) {
  const [s, setS] = useState(null);
  const [modal, setModal] = useState(false);
  const load = useCallback(async () => { const r = await get("/api/pingone/status"); setS(r.ok ? r.data : null); return r.ok ? r.data : null; }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) return null;
  return (
    <div className="card" data-testid="pingone-signin">
      <h3>PingOne sign-in</h3>
      {!s.configured ? <p className="notice" role="note">Set PINGONE_ENVIRONMENT_ID and PINGONE_MCP_CLIENT_ID in ~/Development/.env, then restart this tool.</p>
        : s.signedIn ? (
          <div className="controls">
            <span className="okt" role="status">Signed in to our PingOne{s.expiresAt ? `, until ${new Date(s.expiresAt).toLocaleTimeString()}` : ""}.</span>
            <button type="button" className="btn" onClick={() => post("/api/pingone/signout").then(load)}>Sign out</button>
          </div>
        ) : (
          <div className="controls">
            <button type="button" className="btn primary" onClick={() => setModal(true)} disabled={modal}>Sign in with PingOne</button>
            <span className="muted small">pi.flow sign-in: no redirect. Optional and untested against a live tenant in this repo.</span>
          </div>
        )}
      {modal && <SignInModal startUrl="/api/pingone/login" credentialsUrl="/api/pingone/credentials" onClose={() => setModal(false)} onDone={() => { setModal(false); load().then(() => onSignedIn?.()); }} />}
    </div>
  );
}
