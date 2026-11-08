import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import { mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = ""; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const NEEDS = { required: true, signedIn: false, issuer: "https://auth.example.com", scopes: ["tools:read"], dynamicRegistration: true, refused: null, redirectUri: "http://127.0.0.1:4810/api/oauth/callback", canRefresh: false, expiresAt: null };

async function open(user, overrides) {
  mockServer(overrides);
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /^Open Evil/ }));
}

describe("OAuth panel on the Server page", () => {
  it("shows a discovery problem, but stays hidden for an unreachable server", async () => {
    const user = userEvent.setup();
    await open(user, { "GET /api/connections/c1/oauth": () => ({ __status: 400, body: { error: "oauth_no_metadata", message: "publishes no protected-resource metadata" } }) });
    expect(await screen.findByText(/publishes no protected-resource metadata/)).toBeInTheDocument();
    cleanup(); window.location.hash = "";
    await open(user, { "GET /api/connections/c1/oauth": () => ({ __status: 502, body: { error: "oauth_unreachable", message: "unreachable" } }) });
    await waitFor(() => expect(sent("GET /api/connections/c1/oauth")).toHaveLength(1));
    expect(screen.queryByTestId("oauth")).toBeNull();
  });

  it("is hidden when the server needs no token", async () => {
    const user = userEvent.setup();
    await open(user, { "GET /api/connections/c1/oauth": () => ({ required: false, signedIn: false }) });
    await screen.findByRole("heading", { level: 2, name: /^Server:/ });
    await waitFor(() => expect(sent("GET /api/connections/c1/oauth")).toHaveLength(1));
    expect(screen.queryByTestId("oauth")).toBeNull();
  });

  it("starts the sign-in in a new tab, waits, then reloads the tools; no token is shown", async () => {
    let state = NEEDS;
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    await open(user, {
      "GET /api/connections/c1/oauth": () => state,
      "POST /api/connections/c1/oauth/start": () => ({ authorizeUrl: "https://auth.example.com/authorize?x=1", issuer: NEEDS.issuer, scopes: NEEDS.scopes, registration: "dynamic" }),
    });
    const panel = await screen.findByTestId("oauth");
    expect(panel).toHaveTextContent("https://auth.example.com");
    expect(panel).toHaveTextContent("tools:read");
    await user.click(screen.getByRole("button", { name: "Sign in (opens a new tab)" }));
    expect(opened).toHaveBeenCalledWith("https://auth.example.com/authorize?x=1", "_blank", "noopener,noreferrer");
    expect(screen.getByRole("button", { name: /Waiting for the sign-in tab/ })).toBeDisabled();
    const listsBefore = sent("GET /api/connections/c1/tools").length;
    state = { ...NEEDS, signedIn: true, canRefresh: true, expiresAt: Date.now() + 3600e3 };
    await waitFor(() => expect(screen.getByTestId("oauth-state")).toHaveTextContent("Signed in"), { timeout: 4000 });
    await waitFor(() => expect(sent("GET /api/connections/c1/tools").length).toBeGreaterThan(listsBefore));
    expect(document.body.textContent).not.toMatch(/access_token|Bearer /);
  });

  it("asks for a client id when the server has no dynamic registration, and shows a Ping refusal plainly", async () => {
    const user = userEvent.setup();
    await open(user, { "GET /api/connections/c1/oauth": () => ({ ...NEEDS, dynamicRegistration: false }), "POST /api/connections/c1/oauth/start": () => ({ authorizeUrl: "https://a/x" }) });
    vi.spyOn(window, "open").mockImplementation(() => null);
    const button = await screen.findByRole("button", { name: "Sign in (opens a new tab)" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(/Client id registered/), "my-client");
    await user.click(button);
    expect(sent("POST /api/connections/c1/oauth/start")[0].body).toEqual({ clientId: "my-client" });
    cleanup();
    window.location.hash = "";
    await open(user, { "GET /api/connections/c1/oauth": () => ({ ...NEEDS, refused: "Ping sign-in is pi.flow only (rule 16)." }) });
    expect(await screen.findByText(/pi\.flow only \(rule 16\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
  });
});
