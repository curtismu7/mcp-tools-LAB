import React from "react";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import { gatewayOrigin, mockServer, routeGatewayTo, sent } from "../../testUtil.js";

// The teaching sections of the Entitled listing page, the guided steps (against the real simulated engine) and Real
// mode (against faked /api/gateway/real replies; the server side is covered in server/test/gateway.real.test.js).
beforeEach(() => { window.location.hash = ""; try { localStorage.clear(); } catch { /* none */ } });
afterEach(cleanup);
configure({ asyncUtilTimeout: 8000 });

const active = () => within(screen.getByTestId("six-checks")).queryAllByRole("listitem").filter((li) => li.dataset.active !== undefined).map((li) => li.querySelector("strong").textContent);
async function openPage(user) {
  render(<App />);
  await user.click(await screen.findByRole("link", { name: "Entitled listing" }));
}

describe("Entitled listing: learning in Mock", () => {
  beforeEach(() => { mockServer(); routeGatewayTo(gatewayOrigin()); });

  it("explains the page, the six checks, the words, and shows the gateway diagram", async () => {
    const user = userEvent.setup();
    await openPage(user);
    expect(await screen.findByRole("heading", { name: "What this page shows" })).toBeInTheDocument();
    expect(screen.getByTestId("gwl-mode")).toHaveTextContent(/You are in Mock/);
    expect(within(screen.getByTestId("six-checks")).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("heading", { name: "Words on this page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset diagram" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Run")).toBeNull();
    expect(active()).toEqual([]);
  });

  it("each guided step lands on the check it teaches", async () => {
    const user = userEvent.setup();
    await openPage(user);
    await waitFor(() => expect(screen.getByTestId("listing-count")).toBeInTheDocument());
    const step = async (name, check) => {
      await user.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(screen.getByTestId("call-result")).toHaveAttribute("data-state", "refused"));
      await waitFor(() => expect(active()).toEqual([check]));
      expect(screen.getByTestId("try-notice")).toHaveTextContent("What to notice");
    };
    await step("Call a hidden tool by name", "The aggregate policy cap allows it");
    await step("A tool the aggregate never exposes", "The aggregate's ToolFilter exposes it");
    await step("The member says no", "The member's own policy allows this caller");
  });

  it("guest sees one tool; direct use shows what the aggregate hides; a member that goes down is reported", async () => {
    const user = userEvent.setup();
    await openPage(user);
    await waitFor(() => expect(screen.getByTestId("listing-count")).toBeInTheDocument());
    const names = () => within(screen.getByRole("list", { name: "Listed tools" })).queryAllByRole("listitem").map((li) => li.querySelector("code").textContent);
    await user.click(screen.getByRole("button", { name: "Same gateway, a different list" }));
    await waitFor(() => expect(names()).toEqual(["wiki__search_pages"]));
    await user.click(screen.getByRole("button", { name: "Use that member directly" }));
    await waitFor(() => expect(names()).toContain("edit_page"));
    await user.click(screen.getByRole("button", { name: "A member goes down" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Member status" })).getByText("bill").closest("li")).toHaveAttribute("data-state", "unreachable"));
  });
});

const REAL_INFO = { source: "real", realAvailable: true, realReason: null };
const LISTS = {
  full: { ok: true, tools: [{ name: "crm__find", description: "f" }, { name: "crm__export", description: "e" }, { name: "wiki__search", description: "s" }], ms: 12 },
  limited: { ok: true, tools: [{ name: "crm__find", description: "f" }], ms: 9 },
  none: { ok: false, refusal: { status: 400, message: "request refused by policy", layer: "policy" }, ms: 5 },
};
function realServer(overrides = {}) {
  mockServer({
    "GET /api/info": () => REAL_INFO,
    "GET /api/gateway/real": () => ({ available: true, mode: "real", apps: ["full", "limited", "none"], callers: [{ id: "analyst", label: "Analyst" }], reading: "Which check a refusal matches is our reading of the gateway's message." }),
    "POST /api/gateway/real/list": (b) => ({ app: b.app, caller: b.caller, ...LISTS[b.app] }),
    "POST /api/gateway/real/call": (b) => ({ app: b.app, caller: b.caller, tool: b.tool, ok: false, refusal: { status: null, message: `"${b.tool}" is not exposed by this aggregate`, layer: "tool-filter" }, ms: 20 }),
    ...overrides,
  });
}

describe("Entitled listing: Real", () => {
  it("compares every app for the caller, offers hidden names, and calls one only after the box is ticked", async () => {
    realServer();
    const user = userEvent.setup();
    await openPage(user);
    expect(await screen.findByTestId("gwl-mode")).toHaveTextContent(/You are in Real/);
    const table = await screen.findByTestId("real-compare");
    await waitFor(() => expect(within(table).getAllByRole("row")[3]).toHaveTextContent(/refused \(400\): request refused by policy/));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("3 tool(s) listed");
    expect(sent("POST /api/gateway/real/list").map((c) => c.body.app)).toEqual(["full", "limited", "none"]);
    expect(screen.queryByTestId("listing")).toBeNull(); // the simulation's sections are not shown in Real

    await user.click(within(table).getByRole("radio", { name: "limited" }));
    const chips = screen.getByRole("group", { name: "Listed in another app but hidden here" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["crm__export", "wiki__search"]);
    await user.click(within(chips).getByRole("button", { name: "crm__export" }));
    expect(screen.getByLabelText("Tool name")).toHaveValue("crm__export");
    expect(screen.getByRole("button", { name: "Call" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Send a real tools\/call/ }));
    await user.click(screen.getByRole("button", { name: "Call" }));
    const res = await screen.findByTestId("real-call-result");
    expect(res).toHaveAttribute("data-state", "refused");
    expect(res).toHaveTextContent(/Our reading: matches check 4, the ToolFilter/);
    expect(sent("POST /api/gateway/real/call")[0].body).toEqual({ app: "limited", caller: "analyst", tool: "crm__export", confirm: true });
    expect(active()).toEqual(["The aggregate's ToolFilter exposes it"]);
    expect(sent("POST /api/gateway/list")).toHaveLength(0); // the simulation is not asked in Real
  });

  it("names the gateway version the operator set, or asks for it", async () => {
    const info = { available: true, mode: "real", apps: ["full"], callers: [{ id: "analyst", label: "Analyst" }], reading: "r" };
    realServer({ "GET /api/gateway/real": () => ({ ...info, version: "v1.261106" }) });
    const user = userEvent.setup();
    await openPage(user);
    expect(await screen.findByTestId("real-version")).toHaveTextContent("version v1.261106");
    expect(screen.getByTestId("real-note")).toHaveTextContent(/as you set it: the gateway does not report its own/);
  });

  it("asks for the version when none is set", async () => {
    realServer({ "GET /api/gateway/real": () => ({ available: true, mode: "real", apps: ["full"], callers: [{ id: "analyst", label: "Analyst" }], reading: "r", version: null }) });
    const user = userEvent.setup();
    await openPage(user);
    expect(await screen.findByTestId("real-note")).toHaveTextContent(/version not set/);
    expect(screen.queryByTestId("real-version")).toBeNull();
  });

  it("says why when Real is not set up", async () => {
    realServer({ "GET /api/gateway/real": () => ({ available: false, mode: "real", problem: "Real is not configured: no gateway URL." }) });
    const user = userEvent.setup();
    await openPage(user);
    expect(await screen.findByTestId("real-problem")).toHaveTextContent("Real is not configured: no gateway URL.");
    expect(sent("POST /api/gateway/real/list")).toHaveLength(0);
  });
});
