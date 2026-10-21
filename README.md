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

Built and tested. On a clean clone with nothing else checked out, `npm test` runs 79 always-on server tests (all pass) and 42 web tests, plus 1 optional server test that is reported as SKIPPED (the live hostile-server scan, which needs `HOSTILE_MCP_SRC`); with a `hostile-mcp` checkout that one runs too, 80 of 80. `npm run build` passes. `npm run e2e` (not part of `npm test`, not CI) drives a real Chromium against a clean copy of the real hostile server and a benign fixture: banner, scan, findings with evidence, locked then confirm-gated call, offline scan with `[U+XXXX]` characters, diagram, no request outside the app origin, no console errors. Earlier one-off browser passes also covered both stories, presenter mode, light/dark and a 390px width; those are not in the e2e script.



- Server: Streamable HTTP and stdio MCP clients, tools, resources, prompts and the other protocol methods, saved connections, the confirm-gated `tools/call`, the scanner library and CLI, `GET /api/health` (`demo-health/1`), doctor.
- Scanner: 19 rules with stable ids and fixed severities (info, warn, high), evidence spans, invisible/bidi/tag/homoglyph detection with the characters made visible, name-shadowing against a trusted-names list, size/depth/count budgets that end in a "scan truncated" finding, and a machine-readable `scan-report/1` ([schema](docs/scan-report.schema.json)).
- An always-on test that scans a committed snapshot of what the real [hostile-mcp](https://github.com/cmuir_pingcorp/hostile-mcp) server serves (`server/test/fixtures/hostile-snapshot.json`, captured by `node scripts/capture-hostile-snapshot.mjs`, source commit recorded inside it): its poisoned tools, resource and prompt are flagged, its benign tools are not, and the rug-pull shows up on the second list. If a local checkout is newer than the snapshot the test only warns. The same assertions also run as an optional live test that clones the real server (below).
- Web UI: Connect page (saved connections, HTTP or stdio, test, write-only token), Server page (Tools / Resources / Prompts, scan-before-first-use banner, list-changed signal, Scan, verdict, findings by severity with evidence, "what this scan cannot catch"), a call panel with a schema form and a confirm dialog, offline snapshot scan with report download, two stories (generic, airlines and banking packs) with a presenter mode, a ReactFlow diagram (movable boxes, Simulate, Reset, speed), a limits page, light and dark themes. Untrusted strings render as inert text only.

Not verified:

- The optional PingOne hosted-MCP connection (see below) has not been run against a real tenant.
- The scanner's rules are heuristics checked against the hostile server and unit fixtures only; there is no corpus of real-world servers behind them, so the false-positive rate on real servers is unknown.
- The stdio transport was tested against a small fixture server, not against third-party MCP servers.
- The Docker image and compose file were built and run on OrbStack and checked by content (health, page, a pasted snapshot scan, the confirm gate, non-root); that is a manual check, not CI. CI only greps the compose file for the loopback-only port.
- The e2e script needs a hostile-mcp checkout, git, npm and a Playwright Chromium; it is documented, not run by CI.
- The optional live hostile-server test (`hostile.integration.test.js`) is skipped, with `SKIPPED: set HOSTILE_MCP_SRC` in its title, when no `hostile-mcp` checkout is next to this repo, so CI does not run it. The criterion itself does not depend on it: the committed-snapshot test above always runs. The snapshot can go stale; it is not refreshed automatically.

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

`MOCK_ONLY=1` (or `true`) is the hosted-mock switch: the server connects only to its two built-in sample servers (answered in-process, no sockets), refuses any URL, token, stdio command or PingOne request with `403 {error:"mock_only"}`, stores and reads nothing on the host, ignores `.env`, shows a banner, and `/api/health` reports `mode: "mock-only"`.

## Docker

```bash
HOST_PORT=4820 docker compose up --build -d      # http://127.0.0.1:4820 (HOST_PORT defaults to 4810)
docker compose down
```

The image runs as a non-root user. Inside the container the server listens on all interfaces (`MCPTOOLS_BIND`); `docker-compose.yml` publishes `127.0.0.1:HOST_PORT:4810` only, and a test fails if that changes. **stdio connections launch the command you type inside the container**, not on your machine; to scan a stdio server on your machine run the app on the host. Details: [docs/packaging.md](docs/packaging.md).

## SE shelf, Learning Hub, browser run

- Shelf: merge `docs/shelf-entry.json` (D3 and D4, one app) into the shelf's `.data/demos.local.json`; it shows Ready from `/api/health`. **Override `composeFile` first:** the committed value is the author's absolute path (`/Users/cmuir/Development/mcp-tools/docker-compose.yml`); replace it, in both entries, with the absolute path of `docker-compose.yml` in your checkout, or the shelf cannot start the stack.
- Learning Hub: `content-pack.json`, regenerate and validate with `npm run content-pack`.
- Browser run: `npm run build && npm run e2e` (needs a `hostile-mcp` checkout next to this repo; see [docs/packaging.md](docs/packaging.md)).

## How it pairs with the other demos

Inspector sees, scanner judges (and only reports), the Hostile MCP demo is the attack (and shows pinning, which detects change), the Privilege demo controls the calls. [docs/pairing.md](docs/pairing.md).

## Docs

- [docs/scanner.md](docs/scanner.md): evidence, budgets, the report, and what a metadata scan does not catch.
- [docs/scan-rules.md](docs/scan-rules.md): every rule with its severity, what it catches and what it misses (generated).
- [docs/architecture.md](docs/architecture.md), [docs/packaging.md](docs/packaging.md), [docs/pairing.md](docs/pairing.md), [docs/scorecard-next.md](docs/scorecard-next.md) (D35 groundwork note; nothing built), [CHANGELOG.md](CHANGELOG.md).
- [docs/security.md](docs/security.md): every rule above and the test that enforces it.
- [docs/api.md](docs/api.md): the HTTP API.
- [docs/scan-report.schema.json](docs/scan-report.schema.json): `scan-report/1`.

## Where the code came from

Copied (never imported across repos) from the author's AI-DEMO2 `standalone/mcp-inspector` and `standalone/mcp-scanner`, both MIT; each copied file says so in its header comment. Patterns (health contract, doctor, hooks, CI) follow the ID-JAG kit and the SE shelf. Licence: MIT, see [LICENSE](LICENSE) (Copyright (c) 2026 Curtis Muir, carried over from the inspector). An independent community tool, not endorsed by Ping Identity.
