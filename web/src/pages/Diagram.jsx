import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges, getBezierPath, useStore } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import WirePanel from "../components/WirePanel.jsx";
import { WIRE } from "../lib/wire.js";
import { post } from "../lib/api.js";
import { placeLabels } from "../lib/labelSpot.js";
import { BANNER } from "../lib/gateway.js";
import "./Diagram.css";

// One server: connect and see it, the scan JUDGES (and only reports), you decide, the confirm dialog gates the
// call, and the Privilege demo (a separate product) CONTROLS calls on the wire. Boxes are draggable; Simulate walks one
// run; Reset puts everything back; the speed control sets the pace. The caption says in words what the picture shows.
const START = [
  { id: "server", position: { x: 0, y: 120 }, data: { title: "MCP server", sub: "Any server. The Hostile MCP demo is the poisoned one." } },
  { id: "conn", position: { x: 215, y: 120 }, data: { title: "Connection", sub: "initialize, then tools/list, resources, prompts. No call." } },
  { id: "scan", position: { x: 430, y: 120 }, data: { title: "Scan: JUDGE", sub: "Rules over the metadata. Reports only; never blocks." } },
  { id: "findings", position: { x: 645, y: 120 }, data: { title: "Findings", sub: "Rule, severity, evidence. 'No known pattern found' is not 'safe'." } },
  { id: "you", position: { x: 860, y: 120 }, data: { title: "Your decision", sub: "Read the findings before anything is called" } },
  { id: "call", position: { x: 1075, y: 120 }, data: { title: "tools/call", sub: "Only after the confirm dialog shows the exact arguments" } },
  { id: "agent", position: { x: 215, y: -90 }, data: { title: "Agent (no scan)", sub: "Ingests the list unfiltered" } },
  { id: "priv", position: { x: 1075, y: 320 }, data: { title: "Privilege demo: CONTROL", sub: "A separate product that governs the call path" } },
];
const EDGES = [
  { id: "e1", source: "server", target: "conn", sourceHandle: "r", targetHandle: "l", label: "1", short: "1" },
  { id: "e2", source: "conn", target: "scan", sourceHandle: "r", targetHandle: "l", label: "2", short: "2" },
  { id: "e3", source: "scan", target: "findings", sourceHandle: "r", targetHandle: "l", label: "3", short: "3" },
  { id: "e4", source: "findings", target: "you", sourceHandle: "r", targetHandle: "l", label: "4", short: "4" },
  { id: "e5", source: "you", target: "call", sourceHandle: "r", targetHandle: "l", label: "5", short: "5" },
  { id: "e6", source: "conn", target: "agent", sourceHandle: "t", targetHandle: "b", label: "skip the scan", short: "6" },
  { id: "e7", source: "call", target: "priv", sourceHandle: "bb", targetHandle: "tt", label: "on the wire", short: "7" },
];
// Wide layout: boxes 170px wide on a 215px pitch, so the whole picture fits a 1184px canvas at a zoom where the smallest text
// is still 10px or more. Chain edges carry the step number; the caption names the step. Branch edges keep their words.
// Phone layout (600px and narrower): one column of 150px boxes with the titles only (the guide below carries the rest), so
// the text stays at 10px or more when the diagram is fitted to the screen. A branch sits beside the box it leaves.
const NARROW_X = 190;
const col = (i) => ({ x: 0, y: i * 120 });
const NARROW = {
  server: col(0), conn: col(1), scan: col(2), findings: col(3), you: col(4), call: col(5),
  agent: { x: NARROW_X, y: 120 }, priv: { x: NARROW_X, y: 600 },
};
const DOWN = { sourceHandle: "bb", targetHandle: "tt" };
const NARROW_EDGES = { e1: DOWN, e2: DOWN, e3: DOWN, e4: DOWN, e5: DOWN, e6: { sourceHandle: "r", targetHandle: "ls" }, e7: { sourceHandle: "r", targetHandle: "ls" } };

// The entitled-listing view: a Ping release claim (2026-11-02), UNVERIFIED on our tenant, drawn from the lab's own model.
const GW_START = [
  { id: "gcaller", position: { x: 0, y: 120 }, data: { title: "Caller", sub: "Asks tools/list, then calls a tool by name" } },
  { id: "ggw", position: { x: 215, y: 120 }, data: { title: "Gateway: entitlement filter", sub: "Removes tools the caller may not use, and refuses them by name" } },
  { id: "gagg", position: { x: 430, y: 120 }, data: { title: "Aggregate: policy cap", sub: "alias__tool names. The cap limits every member tool" } },
  { id: "ghop", position: { x: 645, y: 120 }, data: { title: "Member hop", sub: "Cap and member policy checked again before forwarding" } },
  { id: "gmember", position: { x: 860, y: 120 }, data: { title: "Member MCP server", sub: "Used directly, only its own policy applies" } },
  { id: "gdown", position: { x: 430, y: 320 }, data: { title: "Unreachable member", sub: "Reported to the caller, not dropped" } },
];
const GW_EDGES = [
  { id: "g1", source: "gcaller", target: "ggw", sourceHandle: "r", targetHandle: "l", label: "1", short: "1" },
  { id: "g2", source: "ggw", target: "gagg", sourceHandle: "r", targetHandle: "l", label: "2", short: "2" },
  { id: "g3", source: "gagg", target: "ghop", sourceHandle: "r", targetHandle: "l", label: "3", short: "3" },
  { id: "g4", source: "ghop", target: "gmember", sourceHandle: "r", targetHandle: "l", label: "4", short: "4" },
  { id: "g5", source: "gdown", target: "gagg", sourceHandle: "t", targetHandle: "b", label: "reported", short: "5" },
];
const GW_NARROW = { gcaller: col(0), ggw: col(1), gagg: col(2), ghop: col(3), gmember: col(4), gdown: { x: NARROW_X, y: 240 } };
const GW_NARROW_EDGES = { g1: DOWN, g2: DOWN, g3: DOWN, g4: DOWN, g5: { sourceHandle: "ls", targetHandle: "rt" } };

export const SCENARIOS = {
  scan: {
    label: "Scan first",
    view: "main",
    steps: [
      { edges: ["e1"], nodes: ["server", "conn"], text: "You connect and the tool lists tools, resources and prompts. Nothing is called." },
      { edges: ["e2"], nodes: ["conn", "scan"], text: "The scan reads the metadata the server sent: hidden instructions, exfil sinks, shadowing, invisible characters." },
      { edges: ["e3"], nodes: ["scan", "findings"], text: "FINDINGS: each has a rule, a severity in words and the evidence. A clean result reads 'no known pattern found'." },
      { edges: ["e4"], nodes: ["findings", "you"], text: "You read the findings. The scan reports; it blocks nothing, and it cannot see a rug-pull that comes later." },
      { edges: ["e5"], nodes: ["you", "call"], text: "If you choose to call a tool, the confirm dialog shows the exact arguments and nothing is sent until you click Send." },
      { edges: ["e7"], nodes: ["call", "priv"], text: "Controlling the call itself (who may call what, with which limits) is the Privilege demo's job, not this tool's." },
    ],
  },
  skip: {
    label: "Skip the scan",
    view: "main",
    steps: [
      { edges: ["e1"], nodes: ["server", "conn"], text: "The server answers tools/list with its metadata." },
      { edges: ["e6"], nodes: ["conn", "agent"], text: "POISON LANDS: with no scan, an agent ingests the poisoned descriptions as trusted context. Nothing in MCP stops it." },
    ],
  },
  gateway: {
    label: "Entitled listing and cap",
    view: "gateway",
    steps: [
      { edges: ["g1"], nodes: ["gcaller", "ggw"], text: "The caller asks the gateway what it may use. (Ping release claim, UNVERIFIED on our tenant: simulated here.)" },
      { edges: ["g2"], nodes: ["ggw", "gagg"], text: "The reply holds only the tools this caller is entitled to, named alias__tool. The aggregate's policy caps what any member tool may be used for. Nothing says what was left out." },
      { edges: ["g5"], nodes: ["gdown", "gagg"], text: "A member that cannot be reached is reported in the reply, not silently dropped." },
      { edges: ["g3"], nodes: ["gagg", "ghop"], text: "A call by name is checked again, so a hidden tool is refused when it is called, not only left off the list." },
      { edges: ["g4"], nodes: ["ghop", "gmember"], text: "At the member hop the cap and the member's own policy are checked a second time, then the call is forwarded." },
    ],
  },
};
export const VIEWS = {
  main: { nodes: START, edges: EDGES, narrow: NARROW, narrowEdges: NARROW_EDGES, label: "Diagram: MCP server, connection, scan, findings, your decision, tools/call and the Privilege demo. Boxes can be dragged." },
  gateway: { nodes: GW_START, edges: GW_EDGES, narrow: GW_NARROW, narrowEdges: GW_NARROW_EDGES, label: "Diagram: caller, gateway entitlement filter, aggregate policy cap, member hop, member server and an unreachable member. Boxes can be dragged." },
};
// Per step: what it prevents and where to see it in the app. The messages on the wire are in lib/wire.js (WIRE).
const GUIDE = {
  server: { prevents: "Trusting a server you have not looked at. Connecting is read-only; nothing runs.", page: "server", pageLabel: "Open the Server page" },
  conn: { prevents: "Calling tools before you know what they are.", page: "server", pageLabel: "Connect in the Server page" },
  scan: { prevents: "Hidden instructions in tool descriptions reaching the model unseen.", page: "server", pageLabel: "Scan in the Server page" },
  findings: { prevents: "Acting on a server without knowing what the scan found.", page: "server", pageLabel: "See findings in the Server page" },
  you: { prevents: "A tool being called by software that no person chose.", page: null },
  call: { prevents: "A call that does something other than the exact arguments you approved.", page: "server", pageLabel: "Call in the Server page" },
  agent: { prevents: "Poisoned descriptions becoming trusted context for an agent.", page: null },
  priv: { prevents: "Calls that exceed the rights or limits you set.", page: null },
  gcaller: { prevents: "A caller learning about tools it may not use.", page: "gateway", pageLabel: "Open the Entitled listing page" },
  ggw: { prevents: "A tool the caller is not entitled to being offered, or being usable by guessing its name.", page: "gateway", pageLabel: "Open the Entitled listing page" },
  gagg: { prevents: "A member tool being used beyond what the aggregate's policy allows.", page: "gateway", pageLabel: "Open the Entitled listing page" },
  ghop: { prevents: "A stale list or a routing slip getting a call past the cap.", page: "gateway", pageLabel: "Open the Entitled listing page" },
  gmember: { prevents: "Confusing the aggregate's rules with the member's own: used directly, the member follows only its own policy.", page: "gateway", pageLabel: "Open the Entitled listing page" },
  gdown: { prevents: "An outage looking like 'no tools here'.", page: "gateway", pageLabel: "Open the Entitled listing page" },
};
const SPEEDS = [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"], ["4", "4x"]];
const BASE_MS = 1600;

// Where each handle sits. A box renders only the handles an edge uses, so no stray dots hang on it.
export const HANDLES = {
  l: ["target", Position.Left], b: ["target", Position.Bottom], tt: ["target", Position.Top], rt: ["target", Position.Right],
  r: ["source", Position.Right], t: ["source", Position.Top], bb: ["source", Position.Bottom], ls: ["source", Position.Left],
};
function Box({ data }) {
  return (
    <div className={`fbox${data.on ? " on" : ""}${data.dim ? " dim" : ""}`} data-layout={data.narrow ? "narrow" : "wide"}>
      {data.handles.map((id) => <Handle key={id} id={id} type={HANDLES[id][0]} position={HANDLES[id][1]} />)}
      <strong>{data.title}</strong>
      {!data.narrow && <span>{data.sub}</span>}
    </div>
  );
}
const nodeTypes = { box: Box };

// Every box's place and size, and every edge's ends and label, as one string each, so an edge redraws only when something
// that matters to a label has moved.
const boxesKey = (s) => JSON.stringify([...s.nodeLookup.values()].map((n) => [n.id, n.internals.positionAbsolute.x, n.internals.positionAbsolute.y, n.measured.width ?? 0, n.measured.height ?? 0]));
const edgesKey = (s) => JSON.stringify(s.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle, e.targetHandle, e.label]));
const positionOf = (handle) => HANDLES[handle][1];
// A bezier edge whose label moves off any box and off the other labels. Dragging a box right up to its neighbour closes the
// gap the label sits in; the label then takes the nearest clear spot instead of landing on a box.
function LabelEdge({ id, label, markerEnd, interactionWidth, ...p }) {
  const nodesKey = useStore(boxesKey);
  const edgeKey = useStore(edgesKey);
  const [path, midX, midY] = getBezierPath(p);
  const spot = useMemo(() => {
    const nodes = JSON.parse(nodesKey).map(([nid, x, y, w, h]) => ({ id: nid, x, y, w, h }));
    const edges = JSON.parse(edgeKey).map(([eid, source, target, sourceHandle, targetHandle, text]) => ({ id: eid, source, target, sourceHandle, targetHandle, label: text }));
    return placeLabels(nodes, edges, positionOf)[id];
  }, [nodesKey, edgeKey, id]);
  return <BaseEdge id={id} path={path} labelX={spot?.x ?? midX} labelY={spot?.y ?? midY} label={label} markerEnd={markerEnd} interactionWidth={interactionWidth} />;
}
// The type name becomes a CSS class (react-flow__edge-<type>); "label" would collide with the label classes.
const edgeTypes = { clear: LabelEdge };

// Phone width, from the same 600px breakpoint as the CSS. jsdom has no matchMedia, so tests get the wide layout.
function useNarrow() {
  const query = "(max-width: 600px)";
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

// embedded: shown inside the Entitled listing page, fixed on the gateway run, without its own heading or run picker.
export default function Diagram({ theme = "system", onNavigate, gw, embedded = false }) {
  const narrow = useNarrow();
  const [selected, setSelected] = useState(null);
  const [scenario, setScenario] = useState(embedded ? "gateway" : "scan");
  const [speed, setSpeed] = useState("1");
  const [step, setStep] = useState(-1);
  const [running, setRunning] = useState(false);
  const [fit, setFit] = useState(0); // bumped by Reset so the picture is fitted again
  const [live, setLive] = useState(null);
  const steps = SCENARIOS[scenario].steps;
  const view = VIEWS[SCENARIOS[scenario].view];
  const start = useMemo(() => view.nodes.map((n) => ({ ...n, position: narrow ? view.narrow[n.id] : n.position })), [view, narrow]);
  // Dragged positions belong to one view at one layout. Anything else starts from that view's own positions, in the same
  // render, so the picture is fitted to the right boxes when the view or the layout changes.
  const startKey = `${SCENARIOS[scenario].view}-${narrow}`;
  const [dragged, setDragged] = useState({ key: startKey, nodes: start });
  const moved = dragged.key === startKey ? dragged.nodes : start;
  useEffect(() => { setSelected(null); }, [startKey]);

  useEffect(() => {
    if (!running) return undefined;
    if (step >= steps.length - 1) { setRunning(false); return undefined; }
    const t = setTimeout(() => setStep((s) => s + 1), BASE_MS / Number(speed));
    return () => clearTimeout(t);
  }, [running, step, steps.length, speed]);

  // On the release-claim view, show what the simulated engine says for the current caller (from the server, not from this file).
  const gwState = gw?.state;
  const showLive = SCENARIOS[scenario].view === "gateway" && gwState?.config;
  useEffect(() => {
    if (!showLive) { setLive(null); return undefined; }
    let stale = false;
    const body = { config: gwState.config, caller: gwState.caller };
    Promise.all([post("/api/gateway/list", body), post("/api/gateway/audit", body)]).then(([l, a]) => {
      if (stale) return;
      setLive(l.ok && a.ok ? { caller: gwState.config.callers.find((c) => c.id === gwState.caller)?.label ?? gwState.caller, listed: l.data.tools.length, hidden: a.data.rows.filter((r) => !r.visible).length, members: l.data.members } : { error: true });
    });
    return () => { stale = true; };
  }, [showLive, gwState?.config, gwState?.caller]);

  const simulate = () => { setStep(0); setRunning(true); };
  const reset = () => { setRunning(false); setStep(-1); setDragged({ key: startKey, nodes: start }); setSelected(null); setFit((n) => n + 1); if (!embedded) gw?.reset?.(); };
  const pick = (s) => { setScenario(s); setRunning(false); setStep(-1); };
  const onNodesChange = useCallback((c) => setDragged((d) => ({ key: startKey, nodes: applyNodeChanges(c, d.key === startKey ? d.nodes : start) })), [startKey, start]);

  const cur = step >= 0 ? steps[step] : null;
  const detailId = selected ?? (cur ? cur.nodes[cur.nodes.length - 1] : null);
  const detail = detailId ? view.nodes.find((n) => n.id === detailId) : null;
  const g = detailId ? GUIDE[detailId] : null;
  const edgeDefs = useMemo(() => view.edges.map((e) => ({ ...e, ...(narrow ? view.narrowEdges[e.id] : {}), label: narrow ? e.short : e.label })), [view, narrow]);
  const nodes = useMemo(() => {
    const used = (id) => [...new Set(edgeDefs.flatMap((e) => [e.source === id && e.sourceHandle, e.target === id && e.targetHandle]).filter(Boolean))];
    return moved.map((n) => ({ ...n, type: "box", data: { ...n.data, narrow, handles: used(n.id), on: !!cur?.nodes.includes(n.id), dim: !!cur && !cur.nodes.includes(n.id) } }));
  }, [moved, cur, edgeDefs, narrow]);
  const edges = useMemo(() => edgeDefs.map(({ short: _short, ...e }) => ({ ...e, type: "clear", animated: !!cur?.edges.includes(e.id), className: cur?.edges.includes(e.id) ? "edge-on" : "", markerEnd: { type: MarkerType.ArrowClosed } })), [cur, edgeDefs]);
  // On a phone the picture is shown whole at full size and the page scrolls past it; it is not a pan-and-zoom area.
  const height = narrow ? Math.max(...start.map((n) => n.position.y)) + 130 : undefined;

  return (
    <>
      {!embedded && <h2>How the pieces fit</h2>}
      {!embedded && <p className="lede">Connect and see, scan to judge before an agent ingests, you decide, the confirm dialog gates the call, and the Privilege demo controls calls on the wire. Drag any box. The third run is a Ping release claim (2026-11-02), UNVERIFIED on our tenant, simulated by this app.</p>}
      <div className="card controls">
        {!embedded && <label>Run<select value={scenario} onChange={(e) => pick(e.target.value)}>{Object.entries(SCENARIOS).map(([id, s]) => <option key={id} value={id}>{s.label}</option>)}</select></label>}
        <label>Speed<select value={speed} onChange={(e) => setSpeed(e.target.value)}>{SPEEDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <button type="button" className="btn primary" onClick={simulate} disabled={running}>Simulate</button>
        <button type="button" className="btn" onClick={reset}>{embedded ? "Reset diagram" : "Reset"}</button>
      </div>
      <div className="flow-wrap" role="group" aria-label={view.label} data-layout={narrow ? "narrow" : "wide"} style={height ? { height } : undefined}>
        <ReactFlow key={`${SCENARIOS[scenario].view}-${narrow}-${fit}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} colorMode={theme}
          fitView fitViewOptions={{ padding: narrow ? 0.04 : 0.12 }} nodesConnectable={false} onNodeClick={(_, n) => setSelected(n.id)} proOptions={{ hideAttribution: true }} minZoom={0.2}
          panOnDrag={!narrow} zoomOnScroll={!narrow} zoomOnPinch={!narrow} zoomOnDoubleClick={!narrow} preventScrolling={!narrow}>
          <Background />
          {!narrow && <Controls showInteractive={false} />}
        </ReactFlow>
      </div>
      <section className="card guide" aria-live="polite" aria-labelledby="guide-h" data-testid="guide">
        {detail && g ? (
          <>
            <h3 id="guide-h">{detail.data.title}</h3>
            <p>{detail.data.sub}</p>
            <p><strong>What this prevents:</strong> {g.prevents}</p>
            {WIRE[detailId] && <WirePanel wire={WIRE[detailId]} />}
            {g.page && <button type="button" className="btn" onClick={() => onNavigate?.(g.page)}>{g.pageLabel}</button>}
          </>
        ) : (
          <>
            <h3 id="guide-h">About each step</h3>
            <p>Click any box, or press Simulate, to see what that step does and where to see it in the app.</p>
          </>
        )}
      </section>
      {showLive && (
        <p className="caption" data-testid="gw-live">
          <strong>{BANNER}.</strong>{" "}
          {live?.error ? "The simulated gateway did not answer." : live ? `Right now, for ${live.caller} through the aggregate: ${live.listed} tool(s) listed and ${live.hidden} hidden (the audit on the Entitled listing page names them). Members: ${live.members.map((m) => `${m.alias} ${m.status}`).join(", ")}.` : "Asking the simulated gateway..."}
        </p>
      )}
      <p className="caption" role="status" aria-live="polite" data-testid="caption">
        {cur ? `Step ${step + 1} of ${steps.length}: ${cur.text}` : "Press Simulate to walk one run through the diagram."}
      </p>
    </>
  );
}
