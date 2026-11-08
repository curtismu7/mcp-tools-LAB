import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import { REPORT, mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = ""; });
afterEach(cleanup);

const TOOLS = [
  { name: "get_my_accounts", description: "List accounts.", inputSchema: { type: "object", properties: {} } },
  { name: "get_account_balance", description: "Balance.", inputSchema: { type: "object", properties: { account_id: { type: "string" }, city: { type: "string", default: "Berlin" }, callback: { type: "string", default: "http://evil.invalid/x" }, user_id: { type: "string" } }, required: ["account_id", "city", "callback"] } },
];
const ACCOUNTS = { content: [{ type: "text", text: JSON.stringify({ accounts: [{ id: "acc-1", name: "Primary Checking" }, { id: "acc-2", name: "<b>Savings</b>" }] }) }] };

async function open(user, { fill = { demo: { city: "Austin" }, identity: { sub: "user-42" } }, report = REPORT, tools = TOOLS } = {}) {
  mockServer({
    "POST /api/connections/c1/scan": () => ({ report, listed: { tools, resources: [], prompts: [] } }),
    "GET /api/connections/c1/fill": () => fill,
    "POST /api/connections/c1/call/preview": (b) => ({ canonical: JSON.stringify({ arguments: b.arguments, name: b.tool }), argsHash: "b".repeat(64) }),
    "POST /api/connections/c1/call": () => ({ result: ACCOUNTS }),
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /^Open Evil/ }));
  await user.click(await screen.findByRole("button", { name: "Scan" }));
  await screen.findByTestId("scan-result");
}

describe("the call form fills in what a person would not know", () => {
  it("fills identity, demo and safe schema values, says where each came from, never a URL default, and keeps them editable", async () => {
    const user = userEvent.setup();
    await open(user, { report: { ...REPORT, findings: [], summary: { high: 0, warn: 0, info: 0, total: 0 } } });
    await user.click(screen.getByRole("button", { name: "Run get_account_balance" }));
    const card = screen.getByTestId("inline-run");
    await waitFor(() => expect(within(card).getByLabelText(/^city/)).toHaveValue("Austin"));
    expect(within(card).getByLabelText(/^user_id/)).toHaveValue("user-42");
    expect(within(card).getByTestId("filled-city")).toHaveTextContent("demo value");
    expect(within(card).getByTestId("filled-user_id")).toHaveTextContent("signed-in user");
    expect(within(card).getByLabelText(/^callback/)).toHaveValue(""); // an off-box default is never filled
    expect(within(card).getByLabelText(/^account_id/)).toHaveValue(""); // nobody can know it: Pick
    expect(sent("POST /api/connections/c1/call")).toHaveLength(0); // filling sends nothing
    await user.clear(within(card).getByLabelText(/^city/));
    await user.type(within(card).getByLabelText(/^city/), "Oslo");
    expect(within(card).queryByTestId("filled-city")).toBeNull(); // edited: no longer "filled in for you"
  });

  it("uses the schema default only when no demo value exists, and never on a flagged tool", async () => {
    const user = userEvent.setup();
    await open(user, { fill: {} });
    await user.click(screen.getByRole("button", { name: "Run get_account_balance" }));
    await waitFor(() => expect(screen.getByLabelText(/^city/)).toHaveValue("Berlin")); // the scan flagged get_weather only: this tool is clean
    expect(screen.getByTestId("filled-city")).toHaveTextContent("from the server's schema");
  });

  it("Pick asks the server's own list tool behind a confirm, once, and fills the chosen id", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Run get_account_balance" }));
    const card = screen.getByTestId("inline-run");
    await user.click(await within(card).findByTestId("pick-account_id"));
    expect(sent("POST /api/connections/c1/call")).toHaveLength(0); // nothing sent before the confirm
    expect(screen.getByTestId("lookup-canonical")).toHaveTextContent('"name":"get_my_accounts"');
    await user.click(screen.getByRole("button", { name: "Send lookup" }));
    expect(sent("POST /api/connections/c1/call")[0].body).toEqual({ tool: "get_my_accounts", arguments: {}, confirm: true, argsHash: "b".repeat(64) });
    const list = await screen.findByTestId("pick-choices");
    expect(list).toHaveTextContent("<b>Savings</b>"); // text, never markup
    expect(document.querySelector("main b")).toBeNull();
    await user.click(within(list).getByRole("button", { name: /Primary Checking/ }));
    expect(within(card).getByLabelText(/^account_id/)).toHaveValue("acc-1");
    expect(within(card).getByTestId("filled-account_id")).toHaveTextContent("picked from the server");
    await user.click(within(card).getByTestId("pick-account_id")); // second time: no second call
    expect(sent("POST /api/connections/c1/call")).toHaveLength(1);
    expect(await screen.findByTestId("pick-choices")).toBeInTheDocument();
  });

  it("does not offer Pick when the list tool was flagged by the scan", async () => {
    const user = userEvent.setup();
    const flaggedReport = { ...REPORT, findings: [{ ruleId: "MT-HI-001", severity: "high", kind: "hidden-instruction", subject: "get_my_accounts", detail: "x", evidence: [] }] };
    await open(user, { report: flaggedReport });
    await user.click(screen.getByRole("button", { name: "Run get_account_balance" }));
    await screen.findByTestId("inline-run");
    expect(screen.queryByTestId("pick-account_id")).toBeNull();
  });
});
