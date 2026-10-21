import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import { mockServer } from "../../testUtil.js";

beforeEach(() => { window.location.hash = ""; document.documentElement.removeAttribute("data-theme"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Diagram", () => {
  it("has movable boxes, Simulate, Reset and a speed control, and narrates each step", async () => {
    mockServer();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await act(async () => { fireEvent.click(await screen.findByRole("link", { name: "How it fits" })); });
    expect(screen.getByRole("group", { name: /Boxes can be dragged/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Speed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByTestId("caption")).toHaveTextContent("Press Simulate");
    for (const t of ["MCP server", "Connection", "Scan: JUDGE", "Findings", "Your decision", "tools/call"]) expect(screen.getByText(t)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Simulate" })); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 6/);
    await act(async () => { await vi.advanceTimersByTimeAsync(1700); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 2 of 6/);
    await act(async () => { fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "4" } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 3 of 6/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset" })); });
    expect(screen.getByTestId("caption")).toHaveTextContent("Press Simulate");
  });

  it("offers the skip-the-scan run", async () => {
    mockServer();
    render(<App />);
    await act(async () => { fireEvent.click(await screen.findByRole("link", { name: "How it fits" })); });
    fireEvent.change(screen.getByLabelText("Run"), { target: { value: "skip" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Simulate" })); });
    expect(screen.getByTestId("caption")).toHaveTextContent(/Step 1 of 2/);
  });
});

describe("Limits page and theme", () => {
  it("lists what a scan misses, and the theme choice sets data-theme", async () => {
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
