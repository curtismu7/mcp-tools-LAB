import { Position, getBezierPath } from "@xyflow/react";

// Where the edge labels go. A label sits at the middle of its edge unless a box or an earlier label is there; then it takes
// the nearest spot that touches neither. Boxes can be dragged until the gap between two of them is closed, and a label must
// never end up under a box. All numbers are in flow units, so the zoom of the picture does not matter. Pure: the same input
// gives the same spots, which is also what lets a test run the production code on a drag it cannot perform in jsdom.
const STEP = 6;
const REACH = 150; // how far from the middle of the edge to look
const MARGIN = 4; // air kept around a label

// The size a label is drawn at: 13px text plus its background.
export const labelSize = (text) => ({ w: String(text ?? "").length * 7 + 14, h: 24 });

const touches = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const labelBox = (centre, text) => { const { w, h } = labelSize(text); return { x: centre.x - w / 2, y: centre.y - h / 2, w, h }; };

// obstacles: [{x, y, w, h}] (boxes and labels already placed). Returns the centre {x, y} for the label.
export function clearSpot(mid, text, obstacles) {
  const { w, h } = labelSize(text);
  const free = (cx, cy) => {
    const box = { x: cx - w / 2 - MARGIN, y: cy - h / 2 - MARGIN, w: w + 2 * MARGIN, h: h + 2 * MARGIN };
    return !obstacles.some((o) => touches(box, o));
  };
  if (free(mid.x, mid.y)) return mid;
  let best = null;
  let bestScore = Infinity;
  for (let dy = -REACH; dy <= REACH; dy += STEP) {
    for (let dx = -REACH; dx <= REACH; dx += STEP) {
      // below costs a little more than above, so ties are broken the same way every time
      const score = Math.hypot(dx, dy) + (dy > 0 ? 0.5 : 0);
      if (score < bestScore && free(mid.x + dx, mid.y + dy)) { best = { x: mid.x + dx, y: mid.y + dy }; bestScore = score; }
    }
  }
  return best ?? mid;
}

export function handlePoint(r, position) {
  if (position === Position.Left) return { x: r.x, y: r.y + r.h / 2 };
  if (position === Position.Right) return { x: r.x + r.w, y: r.y + r.h / 2 };
  if (position === Position.Top) return { x: r.x + r.w / 2, y: r.y };
  return { x: r.x + r.w / 2, y: r.y + r.h };
}

// nodes: [{id, x, y, w, h}]; edges: [{id, source, target, sourceHandle, targetHandle, label}]; positionOf(handleId) -> Position.
// Returns { edgeId: {x, y} }. Edges are placed in order, each avoiding every box and every label placed before it.
// avoid: false puts every label on the middle of its edge (the old behaviour; a test uses it as its control).
export function placeLabels(nodes, edges, positionOf, avoid = true) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = [];
  const spots = {};
  for (const e of edges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) continue;
    const sourcePosition = positionOf(e.sourceHandle), targetPosition = positionOf(e.targetHandle);
    const a = handlePoint(s, sourcePosition), b = handlePoint(t, targetPosition);
    const [, mx, my] = getBezierPath({ sourceX: a.x, sourceY: a.y, targetX: b.x, targetY: b.y, sourcePosition, targetPosition });
    const spot = avoid ? clearSpot({ x: mx, y: my }, e.label, [...nodes, ...placed]) : { x: mx, y: my };
    spots[e.id] = spot;
    placed.push(labelBox(spot, e.label));
  }
  return spots;
}
