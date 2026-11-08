import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import SignInModal from "../../components/SignInModal.jsx";
import { mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = ""; });
afterEach(cleanup);
const P1 = { required: true, method: "piflow", signedIn: false, issuer: "https://auth.pingone.com/env/as", scopes: ["tools:read"], dynamicRegistration: false, refused: null, redirectUri: "http://127.0.0.1:4810/api/oauth/callback" };

describe("the standard Sign in dialog (pi.flow)", () => {
  it("is non-blocking, needs both fields, clears the password, shows the error line, and finishes", async () => {
    let tries = 0;
    mockServer({
      "POST /s": () => ({ run: "r1", state: "credentials_required", status: "USERNAME_PASSWORD_REQUIRED" }),
      "POST /c": () => (++tries === 1 ? { run: "r1", state: "credentials_required", refused: "The username or password is not right." } : { state: "signed_in" }),
    });
    const onDone = vi.fn(); const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SignInModal startUrl="/s" credentialsUrl="/c" onDone={onDone} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Sign in" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(document.querySelector(".modal-backdrop, .signin-backdrop")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeEnabled()); // the start request is done
    const submit = screen.getByRole("button", { name: "Sign in" });
    await user.type(screen.getByLabelText("Username"), "alice");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Password"), "wrong");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(sent("POST /c")[0].body).toEqual({ run: "r1", username: "alice", password: "wrong" });
    expect(await screen.findByRole("alert")).toHaveTextContent("❌ The username or password is not right.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.type(screen.getByLabelText("Password"), "right");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("names a step it cannot show (MFA) instead of pretending", async () => {
    mockServer({
      "POST /s": () => ({ run: "r1", state: "credentials_required", status: "USERNAME_PASSWORD_REQUIRED" }),
      "POST /c": () => ({ run: "r1", state: "stopped", status: "OTP_REQUIRED" }),
    });
    const user = userEvent.setup();
    render(<SignInModal startUrl="/s" credentialsUrl="/c" onDone={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeEnabled());
    await user.type(screen.getByLabelText("Username"), "a"); await user.type(screen.getByLabelText("Password"), "b");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PingOne stopped at OTP_REQUIRED");
  });
});

describe("OAuth card for a server on our PingOne", () => {
  it("offers Sign in with PingOne (no new tab), and reloads the tools when it finishes", async () => {
    let state = P1;
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    mockServer({
      "GET /api/connections/c1/oauth": () => state,
      "POST /api/connections/c1/oauth/piflow": () => ({ run: "r9", state: "credentials_required", status: "USERNAME_PASSWORD_REQUIRED" }),
      "POST /api/connections/c1/oauth/piflow/credentials": () => { state = { ...P1, signedIn: true }; return { state: "signed_in" }; },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^Open Evil/ }));
    await user.click(await screen.findByRole("button", { name: "Sign in with PingOne" }));
    expect(screen.queryByRole("button", { name: /opens a new tab/ })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeEnabled());
    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "pw");
    const lists = sent("GET /api/connections/c1/tools").length;
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByTestId("oauth-state")).toHaveTextContent("Signed in"));
    await waitFor(() => expect(sent("GET /api/connections/c1/tools").length).toBeGreaterThan(lists));
    expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Sign in" })).toBeNull();
  });
});
