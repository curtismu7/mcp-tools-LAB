import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import { mockServer } from "../../testUtil.js";

beforeEach(() => { window.location.hash = "stories"; try { localStorage.clear(); } catch { /* */ } delete document.documentElement.dataset.present; });
afterEach(cleanup);

describe("Stories page and presenter mode", () => {
  it("shows the two stories, re-skins by vertical and switches path", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    const panel = await screen.findByTestId("story-panel");
    expect(panel).toHaveTextContent("scans a third-party MCP server before any agent reads it");
    await user.selectOptions(screen.getByLabelText("Vertical"), "banking");
    expect(panel).toHaveTextContent("Priya scans a fintech partner's payments MCP server");
    await user.selectOptions(screen.getByLabelText("Vertical"), "airlines");
    expect(panel).toHaveTextContent("Mark scans");
    expect(panel).not.toHaveTextContent("⟨missing");

    await user.click(screen.getByRole("button", { name: /^6\s*Call only what you chose/ }));
    expect(panel).toHaveTextContent("The confirm dialog shows the exact arguments".replace("dialog shows", "dialog shows")) ;
  });

  it("switches to the second story and its alternative path", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("story-panel");
    await user.selectOptions(screen.getByLabelText("Story"), "MT2");
    expect(screen.getByRole("heading", { level: 2, name: /looked clean, then changed/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^3\s*Same server, later/ }));
    await user.click(screen.getByRole("button", { name: "Trust the first scan" }));
    expect(screen.getByTestId("story-panel")).toHaveTextContent("only trusts last week's scan");
    expect(screen.getByTestId("story-panel")).toHaveTextContent("Last week's clean result is still on record");
  });

  it("presenter mode shows a Step N of M bar, steps with the arrow keys and exits with Escape", async () => {
    mockServer();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("story-panel");
    await user.click(screen.getByRole("button", { name: "Present" }));
    expect(document.documentElement.dataset.present).toBe("1");
    expect(screen.getByTestId("present-count")).toHaveTextContent("Step 1 of 6");
    await act(async () => { fireEvent.keyDown(window, { key: "ArrowRight" }); });
    expect(screen.getByTestId("present-count")).toHaveTextContent("Step 2 of 6");
    expect(screen.getByRole("button", { name: /^2\s*See what it offers/ })).toHaveAttribute("aria-current", "step");
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(document.documentElement.dataset.present).toBeUndefined();
  });
});
