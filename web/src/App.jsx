import React, { useEffect, useState } from "react";
import { get } from "./lib/api.js";
import Connect from "./pages/Connect.jsx";
import Server from "./pages/Server.jsx";
import Offline from "./pages/Offline.jsx";
import Stories from "./pages/Stories.jsx";
import Diagram from "./pages/Diagram.jsx";
import Limits from "./pages/Limits.jsx";
import { PresentBar, PresentProvider, PresentToggle } from "./present/PresentMode.jsx";

const PAGES = [["connect", "Connect"], ["server", "Server"], ["offline", "Scan a snapshot"], ["stories", "Stories"], ["diagram", "How it fits"], ["limits", "Limits", true]];
const store = {
  read(k) { try { return localStorage.getItem(k); } catch { return null; } },
  write(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};

function Shell() {
  const [page, setPage] = useState(() => (PAGES.some(([id]) => id === window.location.hash.slice(1)) ? window.location.hash.slice(1) : "connect"));
  const [theme, setTheme] = useState(() => store.read("mcp-tools-theme") || "system");
  const [config, setConfig] = useState(null);
  const [active, setActive] = useState(null); // the opened connection (public view: a token only ever shows "set")
  const [scans, setScans] = useState({}); // connection id -> {report, listed}; this session only

  useEffect(() => { get("/api/config").then((r) => setConfig(r.data)); }, []);
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
      {config?.mockOnly && <p className="notice" role="note" data-testid="mock-banner">Hosted, simulated mock: sample data only, nothing leaves this server</p>}
      <main className="page" id="main" tabIndex={-1}>
        {page === "connect" && <Connect config={config} activeId={active?.id} onOpen={open} onRemoved={clear} />}
        {page === "server" && <Server key={active?.id || "none"} conn={active} scan={active ? scans[active.id] : null} onScanned={(id, data) => setScans((s) => ({ ...s, [id]: data }))} onMissing={() => active && clear(active.id)} />}
        {page === "offline" && <Offline config={config} />}
        {page === "stories" && <Stories />}
        {page === "diagram" && <Diagram theme={theme} />}
        {page === "limits" && <Limits />}
      </main>
    </>
  );
}

export default function App() {
  return <PresentProvider><Shell /></PresentProvider>;
}
