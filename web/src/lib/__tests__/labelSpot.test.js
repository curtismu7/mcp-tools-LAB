import { describe, expect, it } from "vitest";
import { HANDLES, VIEWS } from "../../pages/Diagram.jsx";
import { clearSpot, labelBox, labelSize, placeLabels } from "../labelSpot.js";

// jsdom has no layout, so a drag cannot be driven here. The same question is answered on the geometry: drag each box by a
// fixed step (alone, and one after another), place every edge label, and expect no label to touch any box. The browser check
// (scripts/diagram-drag-check.mjs) drives the real page for the same drags.
// Box heights are measured from the rendered boxes, in flow units; widths are the CSS widths of the two layouts.
const WIDE = { w: 170, h: { server: 104, conn: 104, scan: 104, findings: 122, you: 104, call: 104, agent: 84, priv: 106, gcaller: 84, ggw: 125, gagg: 125, ghop: 103, gmember: 84, gdown: 105 } };
const NARROW = { w: 150, h: { server: 43, conn: 43, scan: 43, findings: 43, you: 43, call: 43, agent: 43, priv: 65, gcaller: 43, ggw: 65, gagg: 65, ghop: 43, gmember: 65, gdown: 65 } };
const DRAGS = [[40, 30], [-40, -30], [40, -30], [-40, 30], [100, 60], [-100, 60]];

const touches = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const positionOf = (handle) => HANDLES[handle][1];

// The boxes and label boxes for one arrangement of the boxes, from the production placeLabels.
function arrange(view, narrow, offsets, avoid = true) {
  const L = narrow ? NARROW : WIDE;
  const nodes = view.nodes.map((n) => {
    const p = narrow ? view.narrow[n.id] : n.position;
    const o = offsets[n.id] ?? [0, 0];
    return { id: n.id, x: p.x + o[0], y: p.y + o[1], w: L.w, h: L.h[n.id] };
  });
  const edges = view.edges.map((e) => ({ ...e, ...(narrow ? view.narrowEdges[e.id] : {}), label: narrow ? e.short : e.label }));
  const spots = avoid ? placeLabels(nodes, edges, positionOf) : placeLabels(nodes, edges, positionOf, false); // the default must be to avoid
  return { nodes, labels: edges.map((e) => ({ edge: e.id, box: labelBox(spots[e.id], e.label) })) };
}
const problems = (view, narrow, offsets) => {
  const { nodes, labels } = arrange(view, narrow, offsets);
  const found = [];
  for (const l of labels) for (const r of nodes) if (touches(l.box, r)) found.push(`label ${l.edge} touches box ${r.id}`);
  for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) if (touches(labels[i].box, labels[j].box)) found.push(`label ${labels[i].edge} touches label ${labels[j].edge}`);
  return found;
};

describe("edge labels stay off the boxes when a box is dragged", () => {
  for (const [name, view] of Object.entries(VIEWS)) {
    for (const narrow of [false, true]) {
      const layout = narrow ? "phone" : "wide";
      it(`${name} view, ${layout} layout: before any drag, and after dragging each box alone by each step`, () => {
        expect(problems(view, narrow, {})).toEqual([]);
        for (const n of view.nodes) for (const d of DRAGS) expect(problems(view, narrow, { [n.id]: d }), `${n.id} by ${d}`).toEqual([]);
      });
      it(`${name} view, ${layout} layout: dragging the boxes one after another keeps every label clear`, () => {
        for (const d of DRAGS) {
          const offsets = {};
          for (const n of view.nodes) { offsets[n.id] = d; expect(problems(view, narrow, offsets), `up to ${n.id} by ${d}`).toEqual([]); }
        }
      });
    }
  }

  it("control: with every label left on the middle of its edge, the same drags DO put a label on a box (so the test above can fail)", () => {
    let hits = 0;
    for (const view of Object.values(VIEWS)) {
      for (const narrow of [false, true]) {
        for (const n of view.nodes) {
          const { nodes, labels } = arrange(view, narrow, { [n.id]: [40, 30] }, false);
          hits += labels.filter((l) => nodes.some((r) => touches(l.box, r))).length;
        }
      }
    }
    expect(hits).toBeGreaterThan(10);
  });
});

describe("clearSpot", () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  it("keeps the middle of the edge when nothing is there", () => {
    expect(clearSpot({ x: 300, y: 25 }, "1", [box])).toEqual({ x: 300, y: 25 });
  });
  it("moves to the nearest clear spot when a box is on the middle, never under it", () => {
    const s = clearSpot({ x: 50, y: 25 }, "1", [box]);
    const { w, h } = labelSize("1");
    expect(touches({ x: s.x - w / 2, y: s.y - h / 2, w, h }, box)).toBe(false);
    expect(Math.hypot(s.x - 50, s.y - 25)).toBeLessThan(60);
  });
  it("gives the same spot for the same input, and prefers above when above and below are equally near", () => {
    const a = clearSpot({ x: 50, y: 25 }, "1", [box]);
    expect(clearSpot({ x: 50, y: 25 }, "1", [box])).toEqual(a);
    expect(a.y).toBeLessThan(25);
  });
  it("falls back to the middle when no clear spot is near, and sizes a label by its text", () => {
    const wall = { x: -1000, y: -1000, w: 2000, h: 2000 };
    expect(clearSpot({ x: 5, y: 5 }, "1", [wall])).toEqual({ x: 5, y: 5 });
    expect(labelSize("skip the scan").w).toBeGreaterThan(labelSize("1").w);
    expect(labelSize(undefined)).toEqual(labelSize(""));
  });
  it("keeps clear air around the label (4 units), looks as far as 150 units, and steps in whole 6-unit steps", () => {
    // the middle is on the top edge of the box: the label must clear it by its half height (12) plus the air (4), on the 6-unit grid
    const s = clearSpot({ x: 50, y: 0 }, "1", [box]);
    expect(s).toEqual({ x: 50, y: -18 });
    // only a spot about 116 units away is free
    const big = { x: -100, y: -100, w: 300, h: 200 };
    const far = clearSpot({ x: 50, y: 0 }, "1", [big]);
    expect(far.y).toBeLessThanOrEqual(-116);
    expect(touches(labelBox(far, "1"), big)).toBe(false);
  });
  it("a later label avoids an earlier one", () => {
    const first = labelBox({ x: 50, y: 25 }, "1");
    const s = clearSpot({ x: 50, y: 25 }, "2", [first]);
    expect(touches(labelBox(s, "2"), first)).toBe(false);
  });
});
