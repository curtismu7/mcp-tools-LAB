import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../App.jsx";
import WirePanel from "../WirePanel.jsx";
import { SPEC_URL, WIRE, callWire } from "../../lib/wire.js";
import { mockServer } from "../../testUtil.js";

afterEach(cleanup);

describe("WirePanel", () => {
  it("renders request, response, the token split in three and a row per claim with a plain note", () => {
    render(<WirePanel wire={WIRE.call} />);
    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.getByTestId("wire-request")).toHaveTextContent("POST /mcp HTTP/1.1");
    expect(screen.getByTestId("wire-request")).toHaveTextContent('"method": "tools/call"');
    expect(screen.getByTestId("wire-response")).toHaveTextContent("HTTP/1.1 200 OK");
    expect(screen.getByTestId("wire-jwt").textContent.split(".")).toHaveLength(3);
    expect(screen.getByTestId("wire-jwt")).toHaveTextContent("sig-not-real");
    const aud = screen.getByText("aud").closest("tr");
    expect(within(aud).getByText("https://mcp.example.com/mcp")).toBeInTheDocument();
    expect(aud).toHaveTextContent("Who the token is FOR");
    expect(screen.getByText("header.alg").closest("tr")).toHaveTextContent("RS256");
    expect(screen.getByText(/What to notice:/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /authorization specification/ })).toHaveAttribute("href", SPEC_URL);
  });

  it("says plainly when a step has no network traffic", () => {
    render(<WirePanel wire={WIRE.you} />);
    expect(screen.getByTestId("wire-none")).toHaveTextContent("No network call here: this is a decision a person makes");
    expect(screen.queryByTestId("wire-request")).toBeNull();
    expect(screen.queryByTestId("wire-jwt")).toBeNull();
  });

  it("uses only example values", () => {
    const all = JSON.stringify([WIRE, callWire("t", "{}", null)]);
    expect(all).not.toMatch(/pingone|ping-devops|ping\.com/i);
    expect(SPEC_URL).toBe("https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization");
  });

  it("changes with the selected diagram step", async () => {
    mockServer();
    render(<App />);
    await act(async () => { fireEvent.click(await screen.findByRole("link", { name: "How it fits" })); });
    fireEvent.click(screen.getByText("Connection"));
    expect(screen.getByTestId("wire-request")).toHaveTextContent('"method": "tools/list"');
    fireEvent.click(screen.getByText("Your decision"));
    expect(screen.getByTestId("wire-none")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Privilege demo: CONTROL"));
    expect(screen.getByTestId("wire-response")).toHaveTextContent("403 Forbidden");
  });
});

describe("Server call flow", () => {
  it("offers 'What went over the wire' after a preview, with the previewed arguments", async () => {
    mockServer();
    const { default: ConfirmCall } = await import("../ConfirmCall.jsx");
    render(<ConfirmCall connectionId="c1" kind="tool" name="get_weather" params={{ city: "Paris" }} />);
    expect(screen.queryByTestId("wire-details")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview call" })); });
    expect(screen.getByText("What went over the wire")).toBeInTheDocument();
    expect(screen.getByTestId("wire-request")).toHaveTextContent('"city": "Paris"');
  });
});
