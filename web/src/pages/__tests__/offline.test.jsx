import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import { mockServer, sent } from "../../testUtil.js";

beforeEach(() => { window.location.hash = "offline"; });
afterEach(cleanup);

describe("Offline scan page", () => {
  it("scans a pasted snapshot with no connection, shows the result, and downloads the report", async () => {
    mockServer();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    render(<App />);
    const scan = await screen.findByRole("button", { name: "Scan snapshot" });
    expect(scan).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use an example" }));
    await user.click(scan);
    expect(await screen.findByTestId("summary")).toHaveTextContent("2 finding(s)");
    expect(screen.getAllByTestId("evidence")[1].querySelector(".inv")?.textContent).toBe("[U+200B]"); // no full text offline: the excerpt, with its chip
    expect(sent("POST /api/scan")[0].body.snapshot).toContain("get_weather");
    expect(sent("GET /api/connections")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Download scan-report\/1/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("loads a JSON file into the box", async () => {
    mockServer();
    render(<App />);
    const input = await screen.findByLabelText("Load a JSON file");
    const file = new File(['{"tools":[]}'], "s.json", { type: "application/json" });
    file.text = async () => '{"tools":[]}';
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByDisplayValue('{"tools":[]}')).toBeInTheDocument();
  });

  it("shows the cap error", async () => {
    mockServer({ "POST /api/scan": () => ({ __status: 413, body: { message: "snapshot is larger than 10 bytes" } }) });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Use an example" }));
    await user.click(screen.getByRole("button", { name: "Scan snapshot" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/larger than 10 bytes/);
  });
});
