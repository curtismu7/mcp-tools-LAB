import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import { clientCommand } from "../Proxy.jsx";
import { mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = "proxy"; });
afterEach(cleanup);

const OFF = { enabled: false, token: null, routes: [], tokenMethod: "estimate: characters / 4", maxFlows: 200 };
const ON = { ...OFF, enabled: true, token: "tok_abc", routes: [{ id: "mock-sample", label: "Sample server (clean)", transport: "mock", path: "/proxy/mcp/mock-sample" }] };
const FLOW = { id: 7, at: "2026-01-01T00:00:00.000Z", route: "mock-sample", routeLabel: "<b>Sample</b>", via: "bridge", httpMethod: "POST", rpcMethod: "tools/call", status: 200, ms: 3, open: false, requestTokens: 12, responseTokens: 30 };
const DETAIL = { ...FLOW, request: { headers: { "content-type": "application/json", authorization: "[proxy token, not forwarded]" }, body: { bytes: 40, tokens: 12, json: { method: "tools/call", params: { name: "<img src=x onerror=alert(1)>" } } } }, response: { headers: {}, body: { bytes: 90, tokens: 30, json: { result: { content: [{ type: "text", text: "<script>x</script>" }] } } } } };

describe("Live proxy page", () => {
  it("is off until turned on, then shows the token and a Claude Code command per route", async () => {
    let state = OFF;
    mockServer({
      "GET /api/proxy": () => state,
      "POST /api/proxy": (b) => { state = b.enabled ? ON : OFF; return state; },
      "GET /api/proxy/flows": () => ({ flows: [] }),
    });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByTestId("proxy-state")).toHaveTextContent("Off");
    expect(screen.queryByTestId("proxy-token")).toBeNull();
    await user.click(screen.getByTestId("proxy-toggle"));
    expect(sent("POST /api/proxy")[0].body).toEqual({ enabled: true });
    expect(await screen.findByTestId("proxy-token")).toHaveTextContent("tok_abc");
    expect(within(screen.getByTestId("proxy-routes")).getByText(/claude mcp add --transport http sample-server-clean-via-proxy http:\/\/.*\/proxy\/mcp\/mock-sample --header "Authorization: Bearer tok_abc"/)).toBeInTheDocument();
    expect(screen.getByText(/Mock: only the two built-in sample servers/)).toBeInTheDocument();
    await user.click(screen.getByTestId("proxy-toggle"));
    expect(sent("POST /api/proxy")[1].body).toEqual({ enabled: false });
    await waitFor(() => expect(screen.getByTestId("proxy-state")).toHaveTextContent("Off"));
  });

  it("lists flows and opens one; agent and server text is inert", async () => {
    mockServer({
      "GET /api/proxy": () => ON,
      "GET /api/proxy/flows": () => ({ flows: [FLOW] }),
      "GET /api/proxy/flows/7": () => ({ flow: DETAIL }),
      "DELETE /api/proxy/flows": () => ({}),
    });
    const user = userEvent.setup();
    render(<App />);
    const row = await screen.findByTestId("flow-row");
    expect(row).toHaveTextContent("12 / 30");
    expect(row).toHaveTextContent("<b>Sample</b>");
    await user.click(within(row).getByRole("button", { name: "tools/call" }));
    const detail = await screen.findByTestId("flow-detail");
    expect(detail).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(detail).toHaveTextContent("<script>x</script>");
    expect(detail).toHaveTextContent("[proxy token, not forwarded]");
    expect(document.querySelector("img, script:not([src])")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(sent("DELETE /api/proxy/flows")).toHaveLength(1);
  });

  it("builds the client command from the page origin", () => {
    expect(clientCommand("http://127.0.0.1:4810", { label: "My Server!", path: "/proxy/mcp/abc" }, "t1")).toBe('claude mcp add --transport http my-server-via-proxy http://127.0.0.1:4810/proxy/mcp/abc --header "Authorization: Bearer t1"');
  });
});
