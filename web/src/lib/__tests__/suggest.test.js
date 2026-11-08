import { describe, expect, it } from "vitest";
import { choicesFrom, listToolFor, safeSchemaValue, suggestValues } from "../suggest.js";

const f = (name, p = {}, required = false) => ({ name, p, required });

describe("safeSchemaValue: plain text only, never anything that can send data", () => {
  it("takes plain defaults, examples and enums", () => {
    expect(safeSchemaValue({ default: "Austin" })).toBe("Austin");
    expect(safeSchemaValue({ examples: ["AAPL"] })).toBe("AAPL");
    expect(safeSchemaValue({ enum: ["CHECKING", "SAVINGS"] })).toBe("CHECKING");
    expect(safeSchemaValue({ default: 7 })).toBe(7);
    expect(safeSchemaValue({ default: true })).toBe(true);
  });
  it("refuses URLs, addresses, hosts, paths, markup, templates, control and invisible characters, and long text", () => {
    for (const bad of ["http://evil.invalid/x", "https://a.b", "//host/x", "www.x.io", "ops@example.com", "evil.com", "10.0.0.1", "/etc/passwd", "~/x", "C:\\x", "<b>x</b>", "`id`", "$(id)", "{{secret}}", "a\u202eb", "a\u200bb", "x\u0000y", "x".repeat(121)]) {
      expect(safeSchemaValue({ default: bad }), JSON.stringify(bad)).toBeUndefined();
    }
  });
  it("falls through to a later safe candidate", () => {
    expect(safeSchemaValue({ default: "http://x.invalid", examples: ["Oslo"] })).toBe("Oslo");
  });
});

describe("suggestValues", () => {
  const fields = [f("user_id"), f("email"), f("city", { default: "Berlin" }, true), f("callback", { default: "http://evil.invalid/x" }, true), f("symbol"), f("account_id"), f("units", { default: "imperial" })];
  it("identity first, then demo values, then schema values; an id nobody can know is left for Pick", () => {
    const { values, from } = suggestValues(fields, { fill: { identity: { sub: "u-1", email: "a@corp.example" }, demo: { symbol: "AAPL", city: "Austin" } } });
    expect(values).toEqual({ user_id: "u-1", email: "a@corp.example", city: "Austin", symbol: "AAPL" });
    expect(from).toEqual({ user_id: "identity", email: "identity", city: "demo", symbol: "demo" });
    expect(values.callback).toBeUndefined();
    expect(values.account_id).toBeUndefined();
  });
  it("uses the schema when there is no demo value, and never on a flagged tool", () => {
    expect(suggestValues(fields, {}).values).toEqual({ city: "Berlin" }); // the optional "units" default is left for the server
    expect(suggestValues(fields, { flagged: true }).values).toEqual({});
    expect(suggestValues(fields, { flagged: true, fill: { demo: { symbol: "AAPL" } } }).values).toEqual({ symbol: "AAPL" });
  });
  it("fills a boolean as a boolean", () => {
    expect(suggestValues([f("dry_run", { default: true }, true)], {}).values.dry_run).toBe(true);
    expect(suggestValues([f("dry_run", { default: true })], {}).values.dry_run).toBeUndefined();
  });
});

describe("Pick: find the list tool and read the choices", () => {
  const tools = [{ name: "get_my_accounts", inputSchema: {} }, { name: "get_account_balance", inputSchema: { required: ["account_id"] } }, { name: "list_banking_accounts" }, { name: "get_my_transactions" }, { name: "send_email", inputSchema: {} }];
  it("maps an id field to a read-only list tool that needs no arguments", () => {
    expect(listToolFor("account_id", tools)).toBe("get_my_accounts");
    expect(listToolFor("from_account_id", tools)).toBe("get_my_accounts");
    expect(listToolFor("accountId", tools)).toBe("get_my_accounts");
    expect(listToolFor("transaction_id", tools)).toBe("get_my_transactions");
    expect(listToolFor("email", tools)).toBeNull();
    expect(listToolFor("id", tools)).toBeNull();
    expect(listToolFor("ticket_id", tools)).toBeNull();
  });
  it("never picks a tool that needs arguments or is not a getter/lister", () => {
    expect(listToolFor("account_id", [{ name: "get_account_balance", inputSchema: { required: ["account_id"] } }])).toBeNull();
    expect(listToolFor("email_id", [{ name: "send_email", inputSchema: {} }])).toBeNull();
  });
  it("reads {id, label} choices from a text result, a structured one, and nothing from prose", () => {
    const text = JSON.stringify({ success: true, accounts: [{ id: "a-1", accountType: "CHECKING", name: "Primary Checking" }, { id: "a-2", name: "<b>Savings</b>" }] });
    expect(choicesFrom({ content: [{ type: "text", text }] })).toEqual([{ id: "a-1", label: "Primary Checking" }, { id: "a-2", label: "<b>Savings</b>" }]);
    expect(choicesFrom({ structuredContent: { items: [{ id: 5 }] }, content: [] })).toEqual([{ id: "5", label: "" }]);
    expect(choicesFrom({ content: [{ type: "text", text: "no ids here" }] })).toEqual([]);
    expect(choicesFrom(null)).toEqual([]);
  });
});
