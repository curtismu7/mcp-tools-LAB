# MCP tools

Connect to an MCP server, list what it offers, scan that metadata for poison **before an agent ingests it**, and only then call tools, with an explicit confirm step. One repo, one app. Catalog items D3 (MCP inspector) and D4 (MCP scanner); D35 (conformance scorecard) is meant to build on this later.

| Piece | Job |
| --- | --- |
| Inspector | **See** what a server offers (tools, resources, prompts) and call it. |
| Scanner | **Judge** the metadata before an agent ingests it. It **reports; it never blocks**, and it never changes a server's data. |
| Hostile MCP (separate repo) | The attack the scanner is built to catch. |
| Privilege demo (separate product) | **Controls** the calls on the wire. This tool does not. |

Press Scan on a connected server, read the findings with their evidence, and only then call a tool. There is also an offline mode: paste or load a `tools/list` JSON snapshot and scan it with no server at all.

## Status

Built and tested. Last run: 63 server tests and 40 web tests pass, `npm run build` passes, and a browser pass in headless Chromium against a clean copy of the real hostile server and a benign server (connect with a write-only token, banner, scan, grouped findings with highlighted evidence, rug-pull signal on the second list, report download, confirm dialog, offline scan with [U+XXXX] chips, both stories, presenter mode, diagram drag/Simulate/Reset, light/dark/390px, no requests outside the origin, no console errors). That browser pass is a one-off script, not part of `npm test`.



- Server: Streamable HTTP and stdio MCP clients, tools, resources, prompts and the other protocol methods, saved connections, the confirm-gated `tools/call`, the scanner library and CLI, `GET /api/health` (`demo-health/1`), doctor.
- Scanner: 19 rules with stable ids and fixed severities (info, warn, high), evidence spans, invisible/bidi/tag/homoglyph detection with the characters made visible, name-shadowing against a trusted-names list, size/depth/count budgets that end in a "scan truncated" finding, and a machine-readable `scan-report/1` ([schema](docs/scan-report.schema.json)).
- An integration test that clones the real [hostile-mcp](../hostile-mcp) server from a clean copy, runs it on a free loopback port and scans it: its poisoned tools are flagged, its benign ones are not, and the rug-pull shows up on the second list.
- Web UI: Connect page (saved connections, HTTP or stdio, test, write-only token), Server page (Tools / Resources / Prompts, scan-before-first-use banner, list-changed signal, Scan, verdict, findings by severity with evidence, "what this scan cannot catch"), a call panel with a schema form and a confirm dialog, offline snapshot scan with report download, two stories (generic, airlines and banking packs) with a presenter mode, a ReactFlow diagram (movable boxes, Simulate, Reset, speed), a limits page, light and dark themes. Untrusted strings render as inert text only.

Not verified:

- The optional PingOne hosted-MCP connection (see below) has not been run against a real tenant.
- The scanner's rules are heuristics checked against the hostile server and unit fixtures only; there is no corpus of real-world servers behind them, so the false-positive rate on real servers is unknown.
- The stdio transport was tested against a small fixture server, not against third-party MCP servers.
- The Docker image was built and run once on OrbStack (health 200, UI 200, non-root, data dir mode 700); it is not tested in CI.
- The hostile-server integration test is skipped when a `hostile-mcp` checkout is not next to this repo (`HOSTILE_MCP_SRC`), so CI without it does not run it.

## Run it

```bash
npm install
npm run doctor     # node, bind, state dir mode, port; prints no secrets
npm test           # server (node:test) and web (vitest)
npm run build
npm start          # http://127.0.0.1:4810/ (PORT to change)
npm run dev        # API on 4810, Vite on 4811
```

`npm start` serves the built UI from `web/dist`, so run `npm run build` first. Ports start at 4800 so they stay clear of the other demos.

### Scan from the command line

```bash
npm run scan -- http://127.0.0.1:4701/mcp          # a live server (lists; reads resources and prompts; never calls a tool)
npm run scan -- snapshot.json                       # a saved tools/list result, no server
npm run scan -- --card http://host/.well-known/agent-card.json   # an A2A Agent Card
npm run scan -- <url|file> --json                   # the scan-report/1 document
npm run scan -- <url|file> --trusted get_balance,send_email      # flag same-name tools (shadowing)
```

Exit code: 0 clean, 1 a finding at or above `--fail-on` (default `warn`), 2 could not read the input. Auth for a URL goes in the environment (`MCPTOOLS_SCAN_AUTHORIZATION`), not on the command line. Details: [docs/scanner.md](docs/scanner.md).

## Security rules

This tool connects to servers the operator names, so it is built to be careful. Each rule has a test.

- Binds `127.0.0.1` only. Any other address needs `MCPTOOLS_BIND` (an explicit opt-in).
- Every request must carry a loopback `Host` header (DNS-rebinding guard); other names need `MCPTOOLS_ALLOWED_HOSTS`.
- Every state-changing call must carry an `Origin` equal to `Host`: same-origin only.
- Saved connections live in `~/.mcp-tools` (or `DATA_DIR`) in `connections.json`, mode 600, in a mode 700 directory. `npm run doctor` and `/api/health` check the modes.
- A token is never returned by any API, never logged, never put in a trace or shown in the UI (it shows `set`). If a server echoes it back in an error or a result, it is replaced by `[redacted]`.
- `tools/call` needs `{confirm:true, argsHash}`, where `argsHash` is the hash of the exact arguments the operator was shown (`POST .../call/preview` returns them). Without confirm the answer is 428; with a hash that does not match the arguments sent it is 409. Nothing reaches the server first.
- A scan reads metadata (and resource and prompt content). It never calls a tool and never changes a server's data. A finding changes nothing.
- stdio runs only a command typed into the UI this session: no shell, a minimal environment plus the env the operator typed, kept in memory and never written to disk or read from it.
- Redirects from a server are never followed (an auth header must not travel).
- Everything from a server is rendered as text. The page sends a strict CSP.

More in [docs/security.md](docs/security.md).

## Optional: PingOne hosted MCP (off by default, untested here)

`MCPTOOLS_PINGONE=1` adds a "PingOne hosted" connection type: Authorization Code + PKCE (with PAR) against **your own** PingOne OIDC app, then PingOne's hosted MCP server as one more connection with the same scan, call and confirm path. You must set `PINGONE_ENVIRONMENT_ID` and `PINGONE_MCP_CLIENT_ID` (there are no built-in defaults), register `http://127.0.0.1:PORT/api/pingone/callback`, and accept that this path has **not been exercised against a real tenant** in this repo. With the flag on and the ids missing, `/api/health` reports `needs-setup`.

## Docker

```bash
docker build -t mcp-tools .
docker run --rm -p 127.0.0.1:4810:4810 -v mcp-tools-data:/data mcp-tools
```

The image runs as a non-root user and binds all interfaces inside the container (`MCPTOOLS_BIND`); publish the port on loopback only, as above.

## Docs

- [docs/scanner.md](docs/scanner.md): rules, severities, evidence, budgets, the report, and what a metadata scan does not catch.
- [docs/security.md](docs/security.md): every rule above and the test that enforces it.
- [docs/api.md](docs/api.md): the HTTP API.
- [docs/scan-report.schema.json](docs/scan-report.schema.json): `scan-report/1`.

## Where the code came from

Copied (never imported across repos) from the author's AI-DEMO2 `standalone/mcp-inspector` and `standalone/mcp-scanner`, both MIT; each copied file says so in its header comment. Patterns (health contract, doctor, hooks, CI) follow the ID-JAG kit and the SE shelf. Licence: MIT, see [LICENSE](LICENSE) (Copyright (c) 2026 Curtis Muir, carried over from the inspector). An independent community tool, not endorsed by Ping Identity.
