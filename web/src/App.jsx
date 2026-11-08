import React, { useCallback, useEffect, useState } from "react";
import ShelfLink from "./components/ShelfLink.jsx";
import { get, post } from "./lib/api.js";
import Connect from "./pages/Connect.jsx";
import Server from "./pages/Server.jsx";
import Offline from "./pages/Offline.jsx";
import Stories from "./pages/Stories.jsx";
import Diagram from "./pages/Diagram.jsx";
import Limits from "./pages/Limits.jsx";
import Gateway from "./pages/Gateway.jsx";
import Proxy from "./pages/Proxy.jsx";
import ReleaseBanner from "./components/ReleaseBanner.jsx";
import { useGateway } from "./lib/gateway.js";
import { PresentBar, PresentProvider, PresentToggle } from "./present/PresentMode.jsx";

const PAGES = [["connect", "Connect"], ["server", "Server"], ["proxy", "Live proxy"], ["offline", "Scan a snapshot"], ["gateway", "Entitled listing"], ["stories", "Stories"], ["diagram", "How it fits"], ["limits", "Limits", true]];
const store = {
  read(k) { try { return localStorage.getItem(k); } catch { return null; } },
  write(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};

function Shell() {
  const [page, setPage] = useState(() => (PAGES.some(([id]) => id === window.location.hash.slice(1)) ? window.location.hash.slice(1) : "connect"));
  const [theme, setTheme] = useState(() => store.read("mcp-tools-theme") || "system");
  const [config, setConfig] = useState(null);
  const [modeInfo, setModeInfo] = useState(null);
  const [modeNote, setModeNote] = useState("");
  const [active, setActive] = useState(null); // the opened connection (public view: a token only ever shows "set")
  const [scans, setScans] = useState({}); // connection id -> {report, listed}; this session only
  const gw = useGateway(); // the simulated gateway: lives here so one Reset can restore it with the diagram

  useEffect(() => { get("/api/config").then((r) => setConfig(r.data)); }, []);
  // Rule 19: the header toggle asks the server (server-side mode), then reloads the data this session shows.
  useEffect(() => { get("/api/info").then((r) => setModeInfo(r.data)).catch(() => {}); }, []);
  const chooseMode = useCallback((source) => {
    if (source === (modeInfo?.source || "mock")) return;
    post("/api/mode", { source }).then((r) => {
      if (r.ok && r.data?.source) { setModeInfo(r.data); setModeNote(""); get("/api/config").then((c) => setConfig(c.data)); }
      else setModeNote(r.data?.message || `the switch was refused (HTTP ${r.status})`);
    }).catch((e) => setModeNote(e.message));
  }, [modeInfo]);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", theme);
    store.write("mcp-tools-theme", theme);
  }, [theme]);
  useEffect(() => { window.location.hash = page; }, [page]);
  useEffect(() => { document.title = `${PAGES.find(([id]) => id === page)?.[1] || "MCP tools"} · MCP tools`; }, [page]);

  const open = (c, go = true) => { setActive(c); if (go) setPage("server"); };
  const clear = (id) => { setScans((s) => { const { [id]: _gone, ...rest } = s; return rest; }); setActive((a) => (a?.id === id ? null : a)); };

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="top">
        <h1>MCP tools</h1>
        <ShelfLink />
        <div className="seg" role="group" aria-label="Mock or Real" data-testid="mode-toggle">
          <button type="button" aria-pressed={modeInfo?.source !== "real"} aria-disabled={modeInfo?.source === "real" || undefined} onClick={() => chooseMode("mock")} data-testid="mode-mock">Mock</button>
          <button type="button" aria-pressed={modeInfo?.source === "real"} aria-disabled={modeInfo?.realAvailable === false || undefined}
            title={modeInfo?.realAvailable === false && modeInfo?.realReason ? modeInfo.realReason : undefined}
            onClick={() => chooseMode("real")} data-testid="mode-real">Real</button>
        </div>
        <nav aria-label="Pages">
          {PAGES.map(([id, label, admin]) => (
            <a key={id} href={`#${id}`} aria-current={page === id ? "page" : undefined} data-admin-only={admin ? "" : undefined} onClick={(e) => { e.preventDefault(); setPage(id); }}>{label}</a>
          ))}
        </nav>
        <PresentToggle />
        <label className="theme">Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
      </header>
      <PresentBar />
      <ReleaseBanner config={config} />
      {config?.mockOnly && <p className="notice" role="note" data-testid="mock-banner">Hosted, simulated mock: sample data only, nothing leaves this server</p>}
      {modeNote && <p className="notice" role="status" data-testid="mode-note">{modeNote}</p>}
      <main className="page" id="main" tabIndex={-1}>
        {page === "connect" && <Connect config={config} activeId={active?.id} onOpen={open} onRemoved={clear} />}
        {page === "server" && <Server key={active?.id || "none"} conn={active} scan={active ? scans[active.id] : null} onScanned={(id, data) => setScans((s) => ({ ...s, [id]: data }))} onMissing={() => active && clear(active.id)} mockOnly={Boolean(config?.mockOnly)} />}
        {page === "proxy" && <Proxy modeSource={modeInfo?.source || "mock"} />}
        {page === "offline" && <Offline config={config} />}
        {page === "gateway" && <Gateway gw={gw} />}
        {page === "stories" && <Stories />}
        {page === "diagram" && <Diagram theme={theme} onNavigate={setPage} gw={gw} />}
        {page === "limits" && <Limits />}
      </main>
    </>
  );
}

export default function App() {
  return <PresentProvider><Shell /></PresentProvider>;
}
