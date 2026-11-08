import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import { mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = "offline"; });
afterEach(cleanup);

describe("Offline scan page", () => {
  it("opens with the hostile sample already loaded, scans it with no saved server, and downloads the report", async () => {
    mockServer();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByDisplayValue(/get_weather/)).toBeInTheDocument(); // loaded for the user, nothing typed
    expect(sent("POST /api/connections")[0].body).toEqual({ transport: "mock", fixture: "hostile" });
    const scan = screen.getByRole("button", { name: "Scan snapshot" });
    await user.click(scan);
    expect(await screen.findByTestId("summary")).toHaveTextContent("2 finding(s)");
    expect(screen.getAllByTestId("evidence")[1].querySelector(".inv")?.textContent).toBe("[U+200B]"); // no full text offline: the excerpt, with its chip
    expect(sent("POST /api/scan")[0].body.snapshot).toContain("get_weather");
    await user.click(screen.getByRole("button", { name: /Download scan-report\/1/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("locks step 3 until the snapshot is scanned, then runs a tool and shows the server's reply as text", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    const run = await screen.findByTestId("snap-run");
    expect(await within(run).findByTestId("call-locked")).toHaveTextContent(/unlock after a scan/);
    await user.click(screen.getByRole("button", { name: "Scan snapshot" }));
    await screen.findByTestId("summary");
    await user.type(await within(run).findByLabelText(/city/), "Oslo");
    await user.click(within(run).getByRole("button", { name: "Review call" }));
    await user.click(await screen.findByRole("button", { name: "Send call" }));
    expect(await within(run).findByTestId("result")).toHaveTextContent("<script>alert(1)</script> done");
    expect(sent("POST /api/connections/c1/call")[0].body).toMatchObject({ tool: "get_weather", confirm: true });
    expect(within(run).getByText(/a built-in sample, so the reply is simulated/)).toBeInTheDocument();
  });

  it("turns step 3 off when the snapshot text is edited, because it no longer matches the server", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    const box = await screen.findByDisplayValue(/get_weather/);
    await user.type(box, " ");
    expect(await within(screen.getByTestId("snap-run")).findByText(/no longer matches the server/)).toBeInTheDocument();
  });

  it("gets the tools/list from one of our servers and fills the box", async () => {
    mockServer({
      "GET /api/known-servers": () => ({ servers: [{ id: "bank", label: "Banking MCP", url: "http://127.0.0.1:8080/mcp", running: true, needsToken: false, start: "npm start" }] }),
      "POST /api/connections": (b) => (b.transport === "mock"
        ? { connection: { id: "c1", label: "Sample", transport: "mock" }, test: { ok: true } }
        : { connection: { id: "c2", label: "Banking MCP", transport: "http", token: null }, test: { ok: true } }),
      "GET /api/connections/c2/tools": () => ({ tools: [{ name: "get_balance", description: "Balance", inputSchema: { type: "object", properties: {} } }] }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByDisplayValue(/get_weather/);
    await user.click(screen.getByRole("button", { name: "One of our servers" }));
    await user.selectOptions(await screen.findByLabelText("Our servers"), "bank");
    await user.click(screen.getByRole("button", { name: "Get its tools/list" }));
    expect(await screen.findByDisplayValue(/get_balance/)).toBeInTheDocument();
    expect(sent("POST /api/connections")[1].body).toMatchObject({ transport: "http", url: "http://127.0.0.1:8080/mcp" });
    expect(screen.getByTestId("snap-run")).toHaveTextContent(/the real server/);
  });

  it("has nothing to run for a pasted snapshot or an Agent Card, and says why", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByDisplayValue(/get_weather/);
    await user.selectOptions(screen.getByLabelText("Sample"), "a2a");
    expect(await within(screen.getByTestId("snap-run")).findByText(/skills, not callable tools/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Paste or load a file" }));
    fireEvent.change(screen.getByLabelText("Snapshot JSON"), { target: { value: '{"tools":[]}' } });
    expect(within(screen.getByTestId("snap-run")).getByText(/no server behind a pasted snapshot|skills, not callable tools/)).toBeInTheDocument();
  });

  it("loads a JSON file into the box", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByDisplayValue(/get_weather/);
    await user.click(screen.getByRole("button", { name: "Paste or load a file" }));
    const input = await screen.findByLabelText("Load a JSON file");
    const file = new File(['{"tools":[]}'], "s.json", { type: "application/json" });
    file.text = async () => '{"tools":[]}';
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByDisplayValue('{"tools":[]}')).toBeInTheDocument();
  });

  it("shows the cap error", async () => {
    mockServer({ "POST /api/scan": () => ({ __status: 413, body: { message: "snapshot is larger than 10 bytes" } }) });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByDisplayValue(/get_weather/);
    await user.click(screen.getByRole("button", { name: "Scan snapshot" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/larger than 10 bytes/);
  });
});
