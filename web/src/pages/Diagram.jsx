import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// One server: connect and see it, the scan JUDGES (and only reports), you decide, the confirm dialog gates the
// call, and the Privilege demo (a separate product) CONTROLS calls on the wire. Boxes are draggable; Simulate walks one
// run; Reset puts everything back; the speed control sets the pace. The caption says in words what the picture shows.
const START = [
  { id: "server", position: { x: 0, y: 120 }, data: { title: "MCP server", sub: "Any server. The Hostile MCP demo is the poisoned one." } },
  { id: "conn", position: { x: 280, y: 120 }, data: { title: "Connection", sub: "initialize, then tools/list, resources, prompts. No call." } },
  { id: "scan", position: { x: 560, y: 120 }, data: { title: "Scan: JUDGE", sub: "Rules over the metadata. Reports only; never blocks." } },
  { id: "findings", position: { x: 840, y: 120 }, data: { title: "Findings", sub: "Rule, severity, evidence. 'No known pattern found' is not 'safe'." } },
  { id: "you", position: { x: 1120, y: 120 }, data: { title: "Your decision", sub: "Read the findings before anything is called" } },
  { id: "call", position: { x: 1400, y: 120 }, data: { title: "tools/call", sub: "Only after the confirm dialog shows the exact arguments" } },
  { id: "agent", position: { x: 560, y: -80 }, data: { title: "Agent (no scan)", sub: "Ingests the list unfiltered" } },
  { id: "priv", position: { x: 1400, y: 320 }, data: { title: "Privilege demo: CONTROL", sub: "A separate product that governs the call path" } },
];
const EDGES = [
  { id: "e1", source: "server", target: "conn", sourceHandle: "r", targetHandle: "l", label: "1 connect" },
  { id: "e2", source: "conn", target: "scan", sourceHandle: "r", targetHandle: "l", label: "2 metadata" },
  { id: "e3", source: "scan", target: "findings", sourceHandle: "r", targetHandle: "l", label: "3 judge" },
  { id: "e4", source: "findings", target: "you", sourceHandle: "r", targetHandle: "l", label: "4 read" },
  { id: "e5", source: "you", target: "call", sourceHandle: "r", targetHandle: "l", label: "5 confirm" },
  { id: "e6", source: "conn", target: "agent", sourceHandle: "t", targetHandle: "b", label: "skip the scan" },
  { id: "e7", source: "call", target: "priv", sourceHandle: "b", targetHandle: "t", label: "on the wire" },
];
export const SCENARIOS = {
  scan: {
    label: "Scan first",
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
    steps: [
      { edges: ["e1"], nodes: ["server", "conn"], text: "The server answers tools/list with its metadata." },
      { edges: ["e6"], nodes: ["conn", "agent"], text: "POISON LANDS: with no scan, an agent ingests the poisoned descriptions as trusted context. Nothing in MCP stops it." },
    ],
  },
};
// Per step: what it prevents, the real message on the wire (where there is one), and where to see it in the app.
const GUIDE = {
  server: { prevents: "Trusting a server you have not looked at. Connecting is read-only; nothing runs.", message: null, page: "server", pageLabel: "Open the Server page" },
  conn: { prevents: "Calling tools before you know what they are.", message: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }, null, 2), page: "server", pageLabel: "Connect in the Server page" },
  scan: { prevents: "Hidden instructions in tool descriptions reaching the model unseen.", message: JSON.stringify({ result: { tools: [{ name: "get_time", description: "Get the current time. <instruction hidden from the user>" }] } }, null, 2), page: "server", pageLabel: "Scan in the Server page" },
  findings: { prevents: "Acting on a server without knowing what the scan found.", message: JSON.stringify({ rule: "hidden-instruction", severity: "high", evidence: "the text the rule matched" }, null, 2), page: "server", pageLabel: "See findings in the Server page" },
  you: { prevents: "A tool being called by software that no person chose.", message: null, page: null },
  call: { prevents: "A call that does something other than the exact arguments you approved.", message: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_time", arguments: { tz: "UTC" } } }, null, 2), page: "server", pageLabel: "Call in the Server page" },
  agent: { prevents: "Poisoned descriptions becoming trusted context for an agent.", message: null, page: null },
  priv: { prevents: "Calls that exceed the rights or limits you set.", message: null, page: null },
};
const SPEEDS = [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"], ["4", "4x"]];
const BASE_MS = 1600;

function Box({ data }) {
  return (
    <div className={`fbox${data.on ? " on" : ""}${data.dim ? " dim" : ""}`}>
      <Handle id="l" type="target" position={Position.Left} />
      <Handle id="r" type="source" position={Position.Right} />
      <Handle id="t" type="source" position={Position.Top} />
      <Handle id="b" type="target" position={Position.Bottom} />
      <strong>{data.title}</strong>
      <span>{data.sub}</span>
    </div>
  );
}
const nodeTypes = { box: Box };

export default function Diagram({ theme = "system", onNavigate }) {
  const [moved, setMoved] = useState(START);
  const [selected, setSelected] = useState(null);
  const [scenario, setScenario] = useState("scan");
  const [speed, setSpeed] = useState("1");
  const [step, setStep] = useState(-1);
  const [running, setRunning] = useState(false);
  const steps = SCENARIOS[scenario].steps;

  useEffect(() => {
    if (!running) return undefined;
    if (step >= steps.length - 1) { setRunning(false); return undefined; }
    const t = setTimeout(() => setStep((s) => s + 1), BASE_MS / Number(speed));
    return () => clearTimeout(t);
  }, [running, step, steps.length, speed]);

  const simulate = () => { setStep(0); setRunning(true); };
  const reset = () => { setRunning(false); setStep(-1); setMoved(START); setSelected(null); };
  const pick = (s) => { setScenario(s); setRunning(false); setStep(-1); };
  const onNodesChange = useCallback((c) => setMoved((n) => applyNodeChanges(c, n)), []);

  const cur = step >= 0 ? steps[step] : null;
  const detailId = selected ?? (cur ? cur.nodes[cur.nodes.length - 1] : null);
  const detail = detailId ? [...START].find((n) => n.id === detailId) : null;
  const g = detailId ? GUIDE[detailId] : null;
  const nodes = useMemo(() => moved.map((n) => ({ ...n, type: "box", data: { ...n.data, on: !!cur?.nodes.includes(n.id), dim: !!cur && !cur.nodes.includes(n.id) } })), [moved, cur]);
  const edges = useMemo(() => EDGES.map((e) => ({ ...e, animated: !!cur?.edges.includes(e.id), className: cur?.edges.includes(e.id) ? "edge-on" : "", markerEnd: { type: MarkerType.ArrowClosed } })), [cur]);

  return (
    <>
      <h2>How the pieces fit</h2>
      <p className="lede">Connect and see, scan to judge before an agent ingests, you decide, the confirm dialog gates the call, and the Privilege demo controls calls on the wire. Drag any box.</p>
      <div className="card controls">
        <label>Run<select value={scenario} onChange={(e) => pick(e.target.value)}>{Object.entries(SCENARIOS).map(([id, s]) => <option key={id} value={id}>{s.label}</option>)}</select></label>
        <label>Speed<select value={speed} onChange={(e) => setSpeed(e.target.value)}>{SPEEDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <button type="button" className="btn primary" onClick={simulate} disabled={running}>Simulate</button>
        <button type="button" className="btn" onClick={reset}>Reset</button>
      </div>
      <div className="flow-wrap" role="group" aria-label="Diagram: MCP server, connection, scan, findings, your decision, tools/call and the Privilege demo. Boxes can be dragged.">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} colorMode={theme}
          fitView fitViewOptions={{ padding: 0.12 }} nodesConnectable={false} onNodeClick={(_, n) => setSelected(n.id)} proOptions={{ hideAttribution: true }} minZoom={0.2}>
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <section className="card guide" aria-live="polite" aria-labelledby="guide-h" data-testid="guide">
        {detail && g ? (
          <>
            <h3 id="guide-h">{detail.data.title}</h3>
            <p>{detail.data.sub}</p>
            <p><strong>What this prevents:</strong> {g.prevents}</p>
            {g.message && (<><p>The real message for this step:</p><pre className="guide-msg">{g.message}</pre></>)}
            {g.page && <button type="button" className="btn" onClick={() => onNavigate?.(g.page)}>{g.pageLabel}</button>}
          </>
        ) : (
          <>
            <h3 id="guide-h">About each step</h3>
            <p>Click any box, or press Simulate, to see what that step does and where to see it in the app.</p>
          </>
        )}
      </section>
      <p className="caption" role="status" aria-live="polite" data-testid="caption">
        {cur ? `Step ${step + 1} of ${steps.length}: ${cur.text}` : "Press Simulate to walk one run through the diagram."}
      </p>
    </>
  );
}
