// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that
// call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import App from "../App.jsx";
import { mockServer } from "../testUtil.js";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
function withShelf(payload) {
  mockServer({ "GET /api/shelf": () => payload });
}

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [
      { id: "mcp-scanner", verification: mark("in-progress", "In progress") },
      { id: "mcp-tools", verification: mark("verified", "Verified", { note: "Connect, scan and gated call all run on the mock" }) },
    ] });
    render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(bar.getByRole("link", { name: "Shelf" })).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Connect, scan and gated call all run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos), the shelf has no mark for it, or only another lab has one", async () => {
    for (const payload of [
      { shelfUrl: "http://shelf.example" },
      { shelfUrl: "http://shelf.example", demos: [{ id: "mcp-tools", verification: null }] },
      { shelfUrl: "http://shelf.example", demos: [{ id: "mcp-tools", verification: { status: "none", label: "" } }] },
      { shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("verified", "Verified") }] },
    ]) {
      withShelf(payload);
      const { unmount } = render(<App />);
      const bar = within(await screen.findByTestId("top-menu"));
      expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
