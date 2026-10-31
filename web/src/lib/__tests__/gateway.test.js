import { describe, expect, it } from "vitest";
import { ALIAS, allQualified, granted, renameAlias, setMember, toggleCap, toggleGrant, toggleLinked, togglePolicy, toggleToolFilter } from "../gateway.js";

const cfg = () => ({
  callers: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  members: [{ id: "m", alias: "mm", reachable: true, upstream: "none", linkedCallers: [], toolFilter: ["t1", "t2"], tools: [{ name: "t1" }, { name: "t2" }], policy: [{ caller: "a", tools: ["t1"] }] }],
  cap: [{ caller: "a", tools: ["mm__t1"] }],
});

describe("grant helpers", () => {
  it("add, remove, never duplicate, and drop a caller left with nothing", () => {
    let g = toggleGrant([], "a", "x", true);
    expect(g).toEqual([{ caller: "a", tools: ["x"] }]);
    g = toggleGrant(g, "a", "x", true);
    expect(g[0].tools).toEqual(["x"]);
    g = toggleGrant(g, "b", "y", true);
    expect(g.map((e) => e.caller)).toEqual(["a", "b"]);
    g = toggleGrant(g, "a", "x", false);
    expect(g).toEqual([{ caller: "b", tools: ["y"] }]);
    expect(granted(g, "b", "y")).toBe(true);
    expect(granted(g, "a", "x")).toBe(false);
  });
  it("does not change its input", () => {
    const g = [{ caller: "a", tools: ["x"] }];
    toggleGrant(g, "a", "y", true);
    expect(g).toEqual([{ caller: "a", tools: ["x"] }]);
  });
});

describe("config edits", () => {
  it("each edit changes only its own field", () => {
    const c = cfg();
    expect(setMember(c, "m", { reachable: false }).members[0].reachable).toBe(false);
    expect(toggleToolFilter(c, "m", "t2", false).members[0].toolFilter).toEqual(["t1"]);
    expect(toggleLinked(c, "m", "b", true).members[0].linkedCallers).toEqual(["b"]);
    expect(togglePolicy(c, "m", "b", "t2", true).members[0].policy).toEqual([{ caller: "a", tools: ["t1"] }, { caller: "b", tools: ["t2"] }]);
    expect(toggleCap(c, "b", "mm__t2", true).cap).toEqual([{ caller: "a", tools: ["mm__t1"] }, { caller: "b", tools: ["mm__t2"] }]);
    expect(c).toEqual(cfg());
  });
  it("renaming an alias carries the cap with it, and refuses a bad or taken alias", () => {
    const c = cfg();
    const r = renameAlias(c, "m", "kb");
    expect(r.members[0].alias).toBe("kb");
    expect(r.cap).toEqual([{ caller: "a", tools: ["kb__t1"] }]);
    expect(allQualified(r)).toEqual(["kb__t1", "kb__t2"]);
    for (const bad of ["", "A", "9x", "a__b", "x".repeat(17), "has space"]) expect(renameAlias(c, "m", bad)).toBe(c);
    const two = { ...c, members: [...c.members, { ...c.members[0], id: "n", alias: "nn" }] };
    expect(renameAlias(two, "m", "nn")).toBe(two);
    expect(ALIAS.test("ok-1")).toBe(true);
  });
});
