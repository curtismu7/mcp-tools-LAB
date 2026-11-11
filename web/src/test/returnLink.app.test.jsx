// Opened from Customer Agent LAB: the strip and the header Back button show; nothing is preselected.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { returnLinkFor } from "../return-link/returnTargets.js";
import { mockServer } from "../testUtil.js";
import App from "../App.jsx";

const NOTE = { name: "Opened from Customer Agent LAB" };
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

describe("return link", () => {
  it("the vendored files match return-link.sha256, which names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "return-link");
    const text = fs.readFileSync(path.join(dir, "return-link.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["ReturnLink.jsx", "ReturnLink.test.jsx", "returnTargets.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });

  it("?from=customer-agent: banner first, strip right below, header Back in the header", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC-LEARN3&vertical=banking");
    mockServer();
    render(<App />);
    const note = await screen.findByRole("note", NOTE);
    expect(note.textContent).toContain("UC-LEARN3");
    expect(screen.getByTestId("release-banner").nextElementSibling).toBe(note);
    expect(document.querySelector("header.top > button.return-link--header")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ })).toHaveLength(2);
  });

  it("no from, an unknown from or a bad id: no strip, no button", async () => {
    for (const q of ["/", "/?from=elsewhere&uc=UC-LEARN4", "/?from=customer-agent&uc=%3Cb%3E", "/?from=customer-agent&uc=UC-LEARN4&vertical=a%20b"]) {
      window.history.replaceState(null, "", q);
      mockServer();
      render(<App />);
      await screen.findByTestId("release-banner");
      expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
      expect(screen.queryByRole("note", NOTE)).toBeNull();
      cleanup();
    }
  });

  it("Back goes to the proxy path behind the lab proxy, to the direct URL on the app's own port", () => {
    window.history.replaceState(null, "", "/mcp-tools/?from=customer-agent&uc=UC-LEARN4");
    expect(returnLinkFor("mcp-tools").href).toBe("/customer-agent/?returned=mcp-tools&uc=UC-LEARN4");
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC-LEARN4");
    expect(returnLinkFor("mcp-tools").href).toBe("http://127.0.0.1:5603/?returned=mcp-tools&uc=UC-LEARN4");
  });
});

  it("?from=ai-demo-standalone: strip names AI Demo Standalone, Back goes to /ai-demo-standalone/ under the proxy", () => {
    window.history.replaceState(null, "", "/mcp-tools/?from=ai-demo-standalone&uc=UC12");
    expect(returnLinkFor("mcp-tools").href).toBe("/ai-demo-standalone/?returned=mcp-tools&uc=UC12");
  });
