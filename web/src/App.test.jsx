import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { Untrusted, segments, visible } from "./lib/Untrusted.jsx";

const REPORT = {
  schema: "scan-report/1", scanner: { enforcement: "none" }, input: { tools: 1, truncated: false },
  summary: { high: 1, warn: 0, info: 0, total: 1 },
  findings: [{ ruleId: "MT-HI-001", severity: "high", kind: "hidden-instruction", subject: "get_weather", detail: "Instruction tag", evidence: [{ field: "description", start: 11, end: 22, excerpt: "<IMPORTANT>" }] }],
  notes: [],
};
const DESC = "Weather.   <IMPORTANT>x";
let calls;
function mockServer(overrides = {}) {
  calls = [];
  const routes = {
    "GET /api/config": () => ({ scanMaxBytes: 1048576, stdio: true, pingone: { enabled: false } }),
    "GET /api/connections": () => ({ connections: [{ id: "c1", label: "Evil <b>server</b>", transport: "http", url: "http://127.0.0.1:1/mcp", token: "set" }] }),
    "GET /api/protocol-methods": () => ({ methods: [{ method: "resources/list", description: "List resources", inputSchema: {} }] }),
    "GET /api/connections/c1/tools": () => ({ tools: [{ name: "get_weather", description: DESC }, { name: "<img src=x onerror=alert(1)>", description: "x" }] }),
    "POST /api/connections/c1/scan": () => ({ report: REPORT, listed: { tools: [{ name: "get_weather", description: DESC }], resources: [], prompts: [] } }),
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

beforeEach(() => { window.location.hash = ""; document.documentElement.removeAttribute("data-theme"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Untrusted text is inert", () => {
  it("shows markup as text and makes invisible characters visible", () => {
    const { container } = render(<Untrusted text={"<img src=x onerror=alert(1)> a​b ‮"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("[U+200B]");
    expect(container.textContent).toContain("[U+202E]");
  });
  it("marks evidence spans by offset", () => {
    expect(segments("abcdef", [{ start: 2, end: 4 }])).toEqual([{ text: "ab", hot: false }, { text: "cd", hot: true, rule: undefined }, { text: "ef", hot: false }]);
    expect(visible("a\u0000b")).toBe("a[U+0000]b");
  });
});

describe("Connect, see, judge, then call", () => {
  it("lists tools as inert text, keeps the call locked until a scan, then runs the confirm flow", async () => {
    mockServer();
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole("button", { name: /^Evil <b>server<\/b> http/ }));
    expect(await screen.findByText("get_weather")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/token set/)).toBeInTheDocument();
    expect(screen.getByTestId("call-locked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText(/1 finding\(s\): 1 high, 0 warn, 0 info/)).toBeInTheDocument();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(screen.getByText("MT-HI-001")).toBeInTheDocument();
    expect(screen.getByText(/never blocks/)).toBeInTheDocument();
    expect(container.querySelector("mark")?.textContent).toBe("<IMPORTANT>");

    await user.selectOptions(screen.getByLabelText("Tool"), "get_weather");
    fireEvent.change(screen.getByLabelText("Arguments (JSON object)"), { target: { value: '{"city":"Oslo"}' } });
    expect(calls.some((c) => c.key === "POST /api/connections/c1/call")).toBe(false);
    await user.click(screen.getAllByRole("button", { name: "Preview call" })[0]);
    expect(await screen.findByTestId("canonical")).toHaveTextContent('{"arguments":{"city":"Oslo"},"name":"get_weather"}');
    expect(screen.getByRole("alert")).toHaveTextContent(/flagged this tool \(high\)/);
    const send = screen.getByRole("button", { name: "Send call" });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I read these exact arguments/ }));
    await user.click(send);
    const result = await screen.findByTestId("result");
    expect(result).toHaveTextContent("<script>alert(1)</script> done");
    expect(result.querySelector("script")).toBeNull();
    const sent = calls.find((c) => c.key === "POST /api/connections/c1/call");
    expect(sent.body).toEqual({ tool: "get_weather", arguments: { city: "Oslo" }, confirm: true, argsHash: "a".repeat(64) });

    // Changing the arguments throws the preview away: a new confirm is needed.
    fireEvent.change(screen.getByLabelText("Arguments (JSON object)"), { target: { value: '{"city":"Rome"}' } });
    await waitFor(() => expect(screen.queryByTestId("preview")).toBeNull());
  });

  it("connects with a token, clears the field, and never shows it back", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Server URL"), "http://127.0.0.1:1/mcp");
    const token = screen.getByLabelText("Auth header value (optional)");
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, "Bearer super-secret-1");
    await user.click(screen.getByRole("button", { name: "Connect and test" }));
    expect(await screen.findByText(/Connected to fake 1/)).toBeInTheDocument();
    expect(screen.getByLabelText("Auth header value (optional)")).toHaveValue("");
    expect(document.body.textContent).not.toContain("super-secret-1");
  });

  it("explains a failed connection test in words", async () => {
    mockServer({ "POST /api/connections": () => ({ connection: { id: "c1", label: "n", transport: "http" }, test: { ok: false, error: "MCP HTTP 401" } }) });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Server URL"), "http://127.0.0.1:1/mcp");
    await user.click(screen.getByRole("button", { name: "Connect and test" }));
    expect(await screen.findByText(/Saved, but the test failed: MCP HTTP 401/)).toBeInTheDocument();
  });

  it("stdio form says what it will launch", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "stdio command" }));
    expect(screen.getByText(/launches the command below on this machine, with no shell/)).toBeInTheDocument();
  });
});

describe("Offline scan", () => {
  it("scans a pasted snapshot and shows a server-side refusal", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("link", { name: "Scan a snapshot" }));
    const scan = screen.getByRole("button", { name: "Scan snapshot" });
    expect(scan).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use an example" }));
    await user.click(scan);
    expect(await screen.findByText(/1 finding\(s\)/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/scan").body.snapshot).toContain("get_weather");
  });
  it("shows the cap error", async () => {
    mockServer({ "POST /api/scan": () => ({ __status: 413, body: { message: "snapshot is larger than 10 bytes" } }) });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("link", { name: "Scan a snapshot" }));
    await user.click(screen.getByRole("button", { name: "Use an example" }));
    await user.click(screen.getByRole("button", { name: "Scan snapshot" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/larger than 10 bytes/);
  });
});

describe("Diagram and pages", () => {
  it("has movable boxes, Simulate, Reset and a speed control, and narrates each step", async () => {
    mockServer();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await act(async () => { fireEvent.click(await screen.findByRole("link", { name: "How it fits" })); });
    expect(screen.getByRole("group", { name: /Boxes can be dragged/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Speed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByTestId("caption")).toHaveTextContent("Press Simulate");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Simulate" })); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 6/);
    await act(async () => { await vi.advanceTimersByTimeAsync(1700); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 2 of 6/);
    await act(async () => { fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "4" } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 3 of 6/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset" })); });
    expect(screen.getByTestId("caption")).toHaveTextContent("Press Simulate");
    expect(screen.getByRole("heading", { name: "How the pieces fit" })).toBeInTheDocument();
  });

  it("limits page lists what a scan misses, and the theme choice sets data-theme", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(await screen.findByLabelText("Theme"), "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await user.click(screen.getByRole("link", { name: "Limits" }));
    expect(await screen.findByText("Rug-pulls after the scan.")).toBeInTheDocument();
    const row = screen.getByText("MT-HI-001").closest("tr");
    expect(within(row).getByText("high")).toBeInTheDocument();
  });
});
