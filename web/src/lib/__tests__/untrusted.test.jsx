import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Untrusted, segments, visible } from "../Untrusted.jsx";

describe("Untrusted text is inert", () => {
  it("shows markup as text and makes invisible characters visible as chips", () => {
    const { container } = render(<Untrusted text={"<img src=x onerror=alert(1)> a​b ‮ c\u{E0041}"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("[U+200B]");
    expect(container.textContent).toContain("[U+202E]");
    expect(container.textContent).toContain("[U+E0041]");
    expect(container.querySelectorAll(".inv").length).toBe(3);
  });
  it("marks evidence spans by offset", () => {
    expect(segments("abcdef", [{ start: 2, end: 4 }])).toEqual([{ text: "ab", hot: false }, { text: "cd", hot: true, rule: undefined }, { text: "ef", hot: false }]);
    expect(visible("a\u0000b")).toBe("a[U+0000]b");
  });
});
