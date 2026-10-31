import { describe, expect, it } from "vitest";
import { fill, fillAll, tokensIn } from "../fill";
import { DEFAULT_VERTICAL, STORIES, VERTICALS, storyById, verticalById } from "../stories";
import { validateStory, validateVertical } from "../storySchema";

const good = () => JSON.parse(JSON.stringify(STORIES[0]));

describe("shipped data", () => {
  it("has the three stories and the generic, airlines and banking packs", () => {
    expect(STORIES.map((s) => s.id)).toEqual(["MT1", "MT2", "MT3"]);
    expect(VERTICALS.map((v) => v.id).sort()).toEqual(["airlines", "banking", "generic"]);
  });
  it.each(STORIES.map((s) => [s.id, s]))("story %s is valid", (_id, s) => expect(validateStory(s)).toEqual([]));
  it.each(VERTICALS.map((v) => [v.id, v]))("vertical %s is valid", (_id, v) => expect(validateVertical(v)).toEqual([]));
  it("every token in every story resolves in every vertical", () => {
    for (const s of STORIES) for (const v of VERTICALS) expect(JSON.stringify(fillAll(s, v)), `${s.id} in ${v.id}`).not.toContain("⟨missing");
  });
  it("no pack or story names a private host, an environment id or a secret", () => {
    const all = JSON.stringify([STORIES, VERTICALS]);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(all).not.toMatch(/AI-DEMO2|pingone\.com|secret|password/i);
  });
  it("the stories reference the Hostile MCP demo and never call a clean scan safe", () => {
    expect(JSON.stringify(storyById("MT2"))).toMatch(/Hostile MCP demo/);
    for (const s of STORIES) expect(JSON.stringify(s)).not.toMatch(/\bis safe\b|\bsafe server\b/i);
  });
});

describe("MT3, the release-claim story", () => {
  const text = JSON.stringify(storyById("MT3"));
  it("labels every product claim as a Ping claim and never as measured", () => {
    expect(text).toMatch(/UNVERIFIED on our tenant/);
    expect(text).toMatch(/Challenge \(Ping claim\)/);
    expect(text).toMatch(/Technical value \(Ping claim\)/);
    expect(text).toMatch(/Business value \(Ping claim\)/);
    expect(text).toMatch(/simulation/);
  });
  it("carries the section 10 lines for the gateway and the aggregate", () => {
    expect(text).toMatch(/one shared token and every tool exposed to every caller/);
    expect(text).toMatch(/one policy cap enforced twice/);
    expect(text).toMatch(/new servers join by configuration, not project work/);
  });
  it("says the filtered-list scan covers one caller, uses cast tokens, and avoids the banned word", () => {
    expect(text).toMatch(/clean for that caller only/);
    expect(text).toMatch(/\{\{ada\}\}/);
    expect(text).not.toMatch(/\bdoor\b/i);
    expect(storyById("MT3").steps).toHaveLength(6);
  });
});

describe("validateStory", () => {
  it("names each problem", () => {
    const s = good();
    s.id = "11"; s.steps[0].n = 9; s.steps[1].n = s.steps[2].n; delete s.steps[0].say; delete s.proof.alt; delete s.paths;
    const errors = validateStory(s).join("\n");
    expect(errors).toContain("id must look like MT1");
    expect(errors).toContain("n must be an integer 1-6");
    expect(errors).toContain("duplicates another step");
    expect(errors).toContain("steps[n=9].say is required text");
    expect(errors).toContain("proof needs main and alt text");
    expect(errors).toContain("paths needs main and alt labels");
  });
  it("rejects an alt without tell and say, and a step order that is not ascending", () => {
    const s = good();
    s.steps.find((x) => x.alt).alt = { tell: "half" };
    expect(validateStory(s).join()).toContain("alt needs tell and say");
    s.steps.reverse();
    expect(validateStory(s).join()).toContain("ascending order");
  });
});

describe("fill", () => {
  const v = { cast: { ada: { name: "Ada" } }, vocab: { server: "a server" } };
  it("replaces cast and vocab tokens and keeps an undefined one visible", () => {
    expect(fill("{{ada}} uses {{ vocab.server }} {{nobody}}", v)).toBe("Ada uses a server ⟨missing: nobody⟩");
  });
  it("lists tokens and copies without changing the source", () => {
    expect([...tokensIn({ a: ["{{x}}", { b: "{{vocab.y}}" }] })].sort()).toEqual(["vocab.y", "x"]);
    const src = { t: "{{ada}}" };
    expect(fillAll(src, v)).toEqual({ t: "Ada" });
    expect(src.t).toBe("{{ada}}");
  });
  it("falls back to generic for an unknown vertical", () => expect(verticalById("nope").id).toBe(DEFAULT_VERTICAL));
});
