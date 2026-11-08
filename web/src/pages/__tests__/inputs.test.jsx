import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import { valuesFrom, fieldsOf } from "../../components/SchemaForm.jsx";
import { estimateTokens } from "../../lib/tokens.js";
import { REPORT, TOOLS, mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = ""; });
afterEach(cleanup);

const SAVED = [
  { id: "i1", connectionId: "c1", tool: "get_weather", name: "Paris, 3 days", arguments: { city: "Paris", days: 3, metric: true, extra: "x" }, source: "flow" },
];

async function scannedServer(user, overrides = {}) {
  mockServer({
    "POST /api/connections/c1/scan": () => ({ report: REPORT, listed: { tools: TOOLS, resources: [], prompts: [] } }),
    "GET /api/connections/c1/inputs?tool=get_weather": () => ({ inputs: SAVED }),
    "POST /api/connections/c1/inputs": (b) => ({ input: { id: "i2", connectionId: "c1", source: "manual", ...b } }),
    "DELETE /api/connections/c1/inputs/i1": () => ({}),
    ...overrides,
  });
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /^Open Evil/ }));
  await user.click(await screen.findByRole("button", { name: "Scan" }));
  await screen.findByTestId("scan-result");
}

describe("token estimates", () => {
  it("are characters / 4 and appear per tool and for the whole list", async () => {
    expect(estimateTokens("abcde")).toBe(2);
    const user = userEvent.setup();
    await scannedServer(user);
    expect(screen.getByTestId("list-tokens")).toHaveTextContent(`~${estimateTokens({ tools: TOOLS })} tokens`);
    expect(screen.getByTestId("list-tokens")).toHaveTextContent("not a tokenizer");
    expect(screen.getAllByTestId("tool-tokens")[0]).toHaveTextContent(`~${estimateTokens(TOOLS[0])} tokens`);
  });
});

describe("saved inputs", () => {
  it("maps arguments back to form values and names the ones the form cannot hold", () => {
    const { values, extra } = valuesFrom(fieldsOf(TOOLS[0].inputSchema), SAVED[0].arguments);
    expect(values).toEqual({ city: "Paris", days: "3", metric: true });
    expect(extra).toEqual(["extra"]);
  });

  it("loads a saved input into the form without calling anything, then the normal review applies", async () => {
    const user = userEvent.setup();
    await scannedServer(user);
    await user.selectOptions(screen.getByLabelText("Tool"), "get_weather");
    const list = await screen.findByTestId("saved-inputs");
    await user.click(within(list).getByRole("button", { name: /Load Paris, 3 days/ }));
    expect(screen.getByDisplayValue("Paris")).toBeInTheDocument();
    expect(screen.getByTestId("saved-note")).toHaveTextContent("extra, which this tool's form has no field for");
    expect(sent("POST /api/connections/c1/call")).toHaveLength(0);
    expect(sent("POST /api/connections/c1/call/preview")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Review call" }));
    expect(sent("POST /api/connections/c1/call/preview")[0].body).toEqual({ tool: "get_weather", arguments: { city: "Paris", days: 3, metric: true } });
    expect(await screen.findByTestId("canonical")).toBeInTheDocument();
  });

  it("saves the current arguments under a name and deletes one", async () => {
    const user = userEvent.setup();
    await scannedServer(user);
    await user.selectOptions(screen.getByLabelText("Tool"), "get_weather");
    await screen.findByTestId("saved-inputs");
    const save = screen.getByRole("button", { name: "Save input" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/^city/), "Oslo");
    await user.type(screen.getByPlaceholderText("a name"), "Oslo");
    await user.click(save);
    expect(sent("POST /api/connections/c1/inputs")[0].body).toEqual({ tool: "get_weather", name: "Oslo", arguments: { city: "Oslo" } });
    expect(await screen.findByTestId("saved-note")).toHaveTextContent('Saved "Oslo"');
    await user.click(screen.getByRole("button", { name: "Delete saved input Paris, 3 days" }));
    expect(sent("DELETE /api/connections/c1/inputs/i1")).toHaveLength(1);
  });
});

describe("live proxy: save a captured call as an input", () => {
  const flow = (route) => ({ id: 4, at: "2026-01-01T00:00:00.000Z", route, routeLabel: "r", via: "passthrough", httpMethod: "POST", rpcMethod: "tools/call", status: 200, ms: 1, open: false, requestTokens: 1, responseTokens: 1 });
  const detail = (route) => ({ ...flow(route), request: { headers: {}, body: { bytes: 9, tokens: 3, json: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_time", arguments: { tz: "UTC" } } } } }, response: null });
  const info = { enabled: true, token: "t", maxFlows: 200, tokenMethod: "estimate", routes: [{ id: "mock-sample", label: "Sample", transport: "mock", path: "/proxy/mcp/mock-sample" }, { id: "c1", label: "Evil", transport: "http", path: "/proxy/mcp/c1" }] };

  it("saves a tools/call to a saved connection, and explains why a fixture call cannot be saved", async () => {
    window.location.hash = "proxy";
    mockServer({
      "GET /api/proxy": () => info,
      "GET /api/proxy/flows": () => ({ flows: [flow("c1"), { ...flow("mock-sample"), id: 5 }] }),
      "GET /api/proxy/flows/4": () => ({ flow: detail("c1") }),
      "GET /api/proxy/flows/5": () => ({ flow: { ...detail("mock-sample"), id: 5 } }),
      "POST /api/connections/c1/inputs": (b) => ({ input: { id: "i9", ...b } }),
    });
    const user = userEvent.setup();
    render(<App />);
    const rows = await screen.findAllByTestId("flow-row");
    await user.click(within(rows[1]).getByRole("button", { name: "tools/call" })); // newest first: #5 then #4
    await user.click(await screen.findByTestId("save-flow"));
    expect(sent("POST /api/connections/c1/inputs")[0].body).toEqual({ tool: "get_time", name: "from flow #4", arguments: { tz: "UTC" }, source: "flow" });
    expect(await screen.findByText(/Saved as "from flow #4"/)).toBeInTheDocument();
    await user.click(within(rows[0]).getByRole("button", { name: "tools/call" }));
    expect(await screen.findByTestId("save-flow")).toBeDisabled();
    expect(screen.getByText("Only calls to a saved connection (Real mode) can be saved as inputs.")).toBeInTheDocument();
  });
});
