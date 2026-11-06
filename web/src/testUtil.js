import { inject, vi } from "vitest";

const nodeFetch = globalThis.fetch;

// The page tests for the simulated gateway talk to the REAL engine, not to canned replies, so a number on the page is a
// number the engine produced. src/globalSetup.js starts the server (in plain Node, on a loopback test port) once per run
// and hands its origin to the tests. Everything else stays faked.
export const gatewayOrigin = () => inject("gatewayOrigin");
/** Call after mockServer(): sends /api/gateway/* to the real engine at `origin`, everything else to the fake. */
export function routeGatewayTo(origin) {
  const fake = globalThis.fetch;
  globalThis.fetch = vi.fn((url, init = {}) => (String(url).startsWith("/api/gateway/")
    ? nodeFetch(origin + url, { ...init, redirect: "error", headers: { ...(init.headers || {}), Origin: origin } })
    : fake(url, init)));
}

// A fake fetch for the page tests. `calls` records every request; `overrides` replace or add routes.
export const REPORT = {
  schema: "scan-report/1", scannedAt: "2026-01-01T00:00:00.000Z", scanner: { enforcement: "none" },
  input: { tools: 2, resources: 1, prompts: 0, truncated: false },
  summary: { high: 1, warn: 1, info: 0, total: 2 },
  findings: [
    { ruleId: "MT-HI-001", severity: "high", kind: "hidden-instruction", subject: "get_weather", detail: "Instruction tag <IMPORTANT>", evidence: [{ field: "description", start: 11, end: 22, excerpt: "<IMPORTANT>" }] },
    { ruleId: "MT-UC-002", severity: "warn", kind: "unicode-trick", subject: "get_weather", detail: "Invisible characters", evidence: [{ field: "description", start: 0, end: 1, excerpt: "[U+200B]" }] },
  ],
  rules: [{ id: "MT-HI-001", severity: "high", kind: "hidden-instruction", title: "Instruction tag in metadata" }, { id: "MT-UC-002", severity: "warn", kind: "unicode-trick", title: "Zero-width characters" }],
  limits: [{ id: "rug-pull", text: "Rug-pulls after the scan." }, { id: "result-injection", text: "Result-based injection." }],
  notes: [],
};
export const CLEAN = { ...REPORT, summary: { high: 0, warn: 0, info: 0, total: 0 }, findings: [] };
export const DESC = "\u200BWeather.  <IMPORTANT>x"; // zero-width space at 0, instruction tag at 11-22
export const TOOLS = [
  { name: "get_weather", description: DESC, inputSchema: { type: "object", properties: { city: { type: "string", description: "<b>City</b>", default: "http://evil.invalid/x" }, days: { type: "integer" }, metric: { type: "boolean" } }, required: ["city"] } },
  { name: "<img src=x onerror=alert(1)>", description: "x", inputSchema: { type: "object", properties: {} } },
];

export let calls;
export function mockServer(overrides = {}) {
  calls = [];
  const routes = {
    "GET /api/config": () => ({ scanMaxBytes: 1048576, stdio: true, pingone: { enabled: false } }),
    "GET /api/info": () => ({ source: "mock", realAvailable: true, realReason: null }),
    "GET /api/connections": () => ({ connections: [{ id: "c1", label: "Evil <b>server</b>", transport: "http", url: "http://127.0.0.1:1/mcp", token: "set" }] }),
    "GET /api/protocol-methods": () => ({ methods: [{ method: "resources/list", description: "List resources", inputSchema: {} }] }),
    "GET /api/connections/c1/tools": () => ({ tools: TOOLS }),
    "POST /api/connections/c1/test": () => ({ test: { ok: true, protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } } }),
    "POST /api/connections/c1/scan": () => ({ report: REPORT, listed: { tools: TOOLS, resources: [{ uri: "file:///<i>a</i>", name: "acct", description: "resource <script>x</script>" }], prompts: [] } }),
    "POST /api/connections/c1/rpc": (b) => ({ result: b.method === "resources/list" ? { resources: [{ uri: "file:///r", name: "r1", description: "d" }] } : { prompts: [{ name: "p1", description: "pd", arguments: [{ name: "a" }] }] } }),
    "POST /api/connections/c1/call/preview": (b) => ({ canonical: JSON.stringify({ arguments: b.arguments, name: b.tool }), argsHash: "a".repeat(64) }),
    "POST /api/connections/c1/call": () => ({ result: { content: [{ type: "text", text: "<script>alert(1)</script> done" }] } }),
    "POST /api/connections": () => ({ connection: { id: "c1", label: "n", transport: "http", token: "set" }, test: { ok: true, protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } } }),
    "POST /api/scan": () => ({ report: REPORT }),
    "GET /api/rules": () => ({ limits: [{ id: "rug-pull", text: "Rug-pulls after the scan." }], rules: [{ id: "MT-HI-001", severity: "high", kind: "hidden-instruction", title: "Instruction tag" }] }),
    ...overrides,
  };
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const key = `${init.method || "GET"} ${url}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    const h = routes[key];
    if (!h) return { ok: false, status: 404, json: async () => ({ message: `no route ${key}` }) };
    const out = h(body);
    return out && out.__status ? { ok: false, status: out.__status, json: async () => out.body } : { ok: true, status: 200, json: async () => out };
  });
}
export const sent = (key) => calls.filter((c) => c.key === key);
