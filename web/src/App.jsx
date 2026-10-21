import React, { useEffect, useState } from "react";
import { get } from "./lib/api.js";
import Workbench from "./pages/Workbench.jsx";
import Offline from "./pages/Offline.jsx";
import Diagram from "./pages/Diagram.jsx";
import Limits from "./pages/Limits.jsx";

const PAGES = [["workbench", "Connect and scan"], ["offline", "Scan a snapshot"], ["diagram", "How it fits"], ["limits", "Limits"]];
const store = {
  read(k) { try { return localStorage.getItem(k); } catch { return null; } },
  write(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};

export default function App() {
  const [page, setPage] = useState(() => (PAGES.some(([id]) => id === window.location.hash.slice(1)) ? window.location.hash.slice(1) : "workbench"));
  const [theme, setTheme] = useState(() => store.read("mcp-tools-theme") || "system");
  const [config, setConfig] = useState(null);

  useEffect(() => { get("/api/config").then((r) => setConfig(r.data)); }, []);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", theme);
    store.write("mcp-tools-theme", theme);
  }, [theme]);
  useEffect(() => { window.location.hash = page; }, [page]);

  return (
    <>
      <header className="top">
        <h1>MCP tools</h1>
        <nav aria-label="Pages">
          {PAGES.map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={page === id ? "page" : undefined} onClick={(e) => { e.preventDefault(); setPage(id); }}>{label}</a>
          ))}
        </nav>
        <label className="theme">Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
      </header>
      <main className="page">
        {page === "workbench" && <Workbench config={config} />}
        {page === "offline" && <Offline config={config} />}
        {page === "diagram" && <Diagram theme={theme} />}
        {page === "limits" && <Limits />}
      </main>
    </>
  );
}
