import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import { mockServer, sent } from "../../testUtil.js";

// Rule 19: the header Mock/Real toggle. The tests fake /api/info and /api/mode so both switch
// directions, a refused switch (409 with a reason) and the data reload are covered in isolation.
beforeEach(() => { window.location.hash = ""; try { localStorage.clear(); } catch { /* none */ } });
afterEach(cleanup);

const REAL_INFO = { source: "real", realAvailable: true, realReason: null };
const MOCK_INFO = { source: "mock", realAvailable: true, realReason: null };
const REFUSED = { error: "real_not_available", message: "Real is not available: this hosted copy is mock only (MOCK_ONLY=1).", source: "mock" };

async function mount({ info, modeReply } = {}) {
  const overrides = {};
  if (info) overrides["GET /api/info"] = () => info;
  if (modeReply) overrides["POST /api/mode"] = () => modeReply;
  mockServer(overrides);
  render(<App />);
  await screen.findByTestId("mode-select");
  await waitFor(() => expect(screen.getByTestId("mode-select")).not.toBeDisabled());
}

const pickMode = async (value) => fireEvent.change(screen.getByTestId("mode-select"), { target: { value } });

describe("rule 19: the Mock/Real toggle", () => {
  it("is in the header on every page, with Mock selected by default", async () => {
    await mount();
    expect(screen.getByTestId("mode-select")).toHaveValue("mock");
    for (const name of ["Server", "Scan a snapshot", "Stories", "How it fits"]) {
      fireEvent.click(screen.getByRole("link", { name }));
      expect(screen.getByTestId("mode-select")).toBeInTheDocument();
      expect(screen.getByTestId("mode-select")).toHaveValue("mock");
    }
  });

  it("switches to Real through POST /api/mode and back to Mock (both directions)", async () => {
    await mount({ modeReply: { source: "real", realAvailable: true, realReason: null } });
    await pickMode("real");
    await waitFor(() => expect(sent("POST /api/mode").length).toBe(1));
    expect(sent("POST /api/mode")[0].body).toEqual({ source: "real" });
    await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
    await pickMode("mock");
    await waitFor(() => expect(sent("POST /api/mode").length).toBe(2));
    expect(sent("POST /api/mode")[1].body).toEqual({ source: "mock" });
  });

  it("after a switch the data is reloaded (a fresh /api/config follows the mode switch)", async () => {
    await mount({ modeReply: { source: "real", realAvailable: true, realReason: null } });
    const before = sent("GET /api/config").length;
    await pickMode("real");
    await waitFor(() => expect(sent("GET /api/config").length).toBeGreaterThan(before));
  });

  it("a refused switch (409 real_not_available) shows the server's reason and changes nothing", async () => {
    await mount({ modeReply: { __status: 409, body: REFUSED } });
    await pickMode("real");
    await waitFor(() => expect(screen.getByTestId("mode-note")).toHaveTextContent(/mock only/));
    expect(screen.getByTestId("mode-select")).toHaveValue("mock");
  });

  it("when Real is unavailable the Real option is disabled with the reason as its tooltip", async () => {
    await mount({ info: { source: "mock", realAvailable: false, realReason: REFUSED.message } });
    const real = screen.getByRole("option", { name: "Real" });
    expect(real).toBeDisabled();
    expect(real).toHaveAttribute("title", REFUSED.message);
  });
});
