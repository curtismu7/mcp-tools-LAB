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

export default function Diagram({ theme = "system" }) {
  const [moved, setMoved] = useState(START);
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
  const reset = () => { setRunning(false); setStep(-1); setMoved(START); };
  const pick = (s) => { setScenario(s); setRunning(false); setStep(-1); };
  const onNodesChange = useCallback((c) => setMoved((n) => applyNodeChanges(c, n)), []);

  const cur = step >= 0 ? steps[step] : null;
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
          fitView fitViewOptions={{ padding: 0.12 }} nodesConnectable={false} proOptions={{ hideAttribution: true }} minZoom={0.2}>
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="caption" role="status" aria-live="polite" data-testid="caption">
        {cur ? `Step ${step + 1} of ${steps.length}: ${cur.text}` : "Press Simulate to walk one run through the diagram."}
      </p>
    </>
  );
}
