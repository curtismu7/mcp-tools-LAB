import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import { mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = ""; document.documentElement.removeAttribute("data-theme"); });
afterEach(cleanup);

describe("Connect page", () => {
  it("lists saved connections as inert text and shows the token as set", async () => {
    mockServer();
    const { container } = render(<App />);
    expect(await screen.findByText("Evil <b>server</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/token set/)).toBeInTheDocument();
  });

  it("tests a saved connection", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Test Evil/ }));
    expect(await screen.findByText(/Connected: fake 1 \(protocol 2025-06-18\)/)).toBeInTheDocument();
    expect(sent("POST /api/connections/c1/test")).toHaveLength(1);
  });

  it("connects with a write-only token, clears the field, never shows it back, and opens the server", async () => {
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
    expect(sent("POST /api/connections")[0].body.token).toBe("Bearer super-secret-1");
    await user.click(screen.getByRole("button", { name: "Open server now" }));
    expect(await screen.findByRole("heading", { level: 2, name: /^Server:/ })).toBeInTheDocument();
  });

  it("explains a failed connection test in words", async () => {
    mockServer({ "POST /api/connections": () => ({ connection: { id: "c1", label: "n", transport: "http" }, test: { ok: false, error: "MCP HTTP 401" } }) });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Server URL"), "http://127.0.0.1:1/mcp");
    await user.click(screen.getByRole("button", { name: "Connect and test" }));
    expect(await screen.findByText(/Saved, but the test failed: MCP HTTP 401/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open server now" })).toBeNull();
  });

  it("the stdio form says what it will launch", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "stdio command" }));
    expect(screen.getByText(/launches the command below on this machine, with no shell/)).toBeInTheDocument();
  });
});
