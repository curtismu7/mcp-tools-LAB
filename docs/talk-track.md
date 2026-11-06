# Talk track: MCP tools LAB

Each `##` heading is one presenter step. This is a Tester-tier tool: connect to an MCP server, list what it offers, scan the metadata for poison **before an agent ingests it**, and only then call a tool — behind an explicit confirm. The scanner reports; it never blocks.

## The pitch in one line

Inspector sees, scanner judges, the hostile MCP server (separate repo) is the attack, and the Privilege demo controls the calls on the wire — this tool does not. Say that division up front so nobody expects blocking.

## Connect a server

Open the Connect page. Pick a saved connection (HTTP or stdio) or add one; the token is write-only — the UI shows `set`, never the value. Press Test, connect.

## See what it offers

The Server page lists Tools, Resources and Prompts. Note the scan-before-first-use banner: the app nudges you to judge the metadata before any agent consumes it. This is where an unsuspicious-looking server would be ingested blindly.

## Press Scan

Press Scan and read the verdict: 19 rules with stable ids and fixed severities (info, warn, high), each finding with its evidence span. Invisible, bidi, tag and homoglyph characters are made visible as `[U+XXXX]`; name-shadowing is checked against a trusted-names list; size/depth/count budgets end in a "scan truncated" finding. Point at "what this scan cannot catch" — the scanner is heuristics, and a clean scan is not a guarantee.

## Scan the hostile server

Connect to the hostile-mcp server and scan it. Its poisoned tools, resource and prompt are flagged; the benign tools are not. A committed snapshot of the real hostile server is always on hand (captured by `scripts/capture-hostile-snapshot.mjs`) if you do not want to run it live — and the snapshot shows the rug-pull: the second `tools/list` that differs from the first.

## Scan offline, with no server

Open the offline mode and paste or load a `tools/list` JSON snapshot — or an A2A Agent Card (`--card`). The same rules run with no server at all, and the machine-readable `scan-report/1` can be downloaded. The CLI does the same: `npm run scan -- snapshot.json` (exit 1 on a finding at or above warn).

## Call a tool — with the confirm gate

Only now call something. The call panel builds a form from the tool's schema; the confirm dialog shows exactly the arguments about to be sent. Under the hood, `tools/call` needs `{confirm:true, argsHash}` — the hash of the arguments you were shown. No confirm is 428; a mismatched hash is 409. Nothing reaches the server first.

## The entitlement simulation

Open the Entitled listing tab and the diagram. A banner says it on every tab: this simulates what Ping's release is said to add — a tool the caller is not entitled to is removed from `tools/list` and refused again when called by name, and an aggregate of member servers (tools named `alias__tool`) has one policy capping every member. It is a simulation in this process; there is no live path, and it is UNVERIFIED on our tenant.

## Two stories, presenter mode

Open the stories (generic, airlines and banking packs) and presenter mode for a scripted narrative with the ReactFlow diagram — movable boxes, Simulate, Reset, speed. Good for a room that wants the arc told rather than the tabs walked.

## What this tool is not

Close on the limits: the scanner never blocks and never changes a server's data; the false-positive rate on real servers is unknown (no real-world corpus behind the rules); a scan of a filtered list covers only what that caller sees. Reset is just disconnecting — connections live in `~/.mcp-tools/connections.json`, and the doctor checks their file modes.
