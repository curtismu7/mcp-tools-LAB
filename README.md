# MCP tools LAB

Tier: Tester
Repo: https://github.com/curtismu7/mcp-tools-LAB

Connect to an MCP server, list what it offers, scan that metadata for poison **before an agent ingests it**, and only then call tools, with an explicit confirm step. One repo, one app. Catalog items D3 (MCP inspector) and D4 (MCP scanner); D35 (conformance scorecard) is meant to build on this later.

| Piece | Job |
| --- | --- |
| Inspector | **See** what a server offers (tools, resources, prompts) and call it. |
| Scanner | **Judge** the metadata before an agent ingests it. It **reports; it never blocks**, and it never changes a server's data. |
| Hostile MCP (separate repo) | The attack the scanner is built to catch. |
| Privilege demo (separate product) | **Controls** the calls on the wire. This tool does not. |

Press Scan on a connected server, read the findings with their evidence, and only then call a tool. There is also an offline mode: paste or load a `tools/list` JSON snapshot and scan it with no server at all.

## Status

Built and tested. On a clean clone with nothing else checked out, `npm test` runs 185 server tests (183 always-on, all pass) and 110 web tests on Node 26, plus 2 optional server tests that are reported as SKIPPED (the live hostile-server scan, which needs `HOSTILE_MCP_SRC`, and the full-swagger check of the release-claim names, which needs `SWAGGER_FILE`); with a `hostile-mcp` checkout and the swagger file those run too. `npm run build` passes. `npm run e2e` (not part of `npm test`, not CI) drives a real Chromium against a clean copy of the real hostile server and a benign fixture: banner, scan, findings with evidence, locked then confirm-gated call, offline scan with `[U+XXXX]` characters, diagram, no request outside the app origin, no console errors. Earlier one-off browser passes also covered both stories, presenter mode, light/dark and a 390px width; those are not in the e2e script.



- Server: Streamable HTTP and stdio MCP clients, tools, resources, prompts and the other protocol methods, saved connections, the confirm-gated `tools/call`, the scanner library and CLI, `GET /api/health` (`demo-health/1`), doctor.
- Scanner: 19 rules with stable ids and fixed severities (info, warn, high), evidence spans, invisible/bidi/tag/homoglyph detection with the characters made visible, name-shadowing against a trusted-names list, size/depth/count budgets that end in a "scan truncated" finding, and a machine-readable `scan-report/1` ([schema](docs/scan-report.schema.json)).
- An always-on test that scans a committed snapshot of what the real [hostile-mcp](https://github.com/curtismu7/hostile-mcp-LAB) server serves (`server/test/fixtures/hostile-snapshot.json`, captured by `node scripts/capture-hostile-snapshot.mjs`, source commit recorded inside it): its poisoned tools, resource and prompt are flagged, its benign tools are not, and the rug-pull shows up on the second list. If a local checkout is newer than the snapshot the test only warns. The same assertions also run as an optional live test that clones the real server (below).
- Web UI: Connect page (an **Our servers** dropdown that fills every field for a server this family runs, saved connections, HTTP or stdio, test, write-only token), Server page (Tools / Resources / Prompts, scan-before-first-use banner, list-changed signal, Scan, verdict, findings by severity with evidence, "what this scan cannot catch"), a call panel with a schema form and a confirm dialog, offline snapshot scan with report download, two stories (generic, airlines and banking packs) with a presenter mode, a ReactFlow diagram (movable boxes, Simulate, Reset, speed), a limits page, light and dark themes. Untrusted strings render as inert text only.

Not verified:

- The optional PingOne hosted-MCP connection (see below) has not been run against a real tenant.
- The scanner's rules are heuristics checked against the hostile server and unit fixtures only; there is no corpus of real-world servers behind them, so the false-positive rate on real servers is unknown.
- The stdio transport was tested against a small fixture server, not against third-party MCP servers.
- The Docker image and compose file were built and run on OrbStack and checked by content (health, page, a pasted snapshot scan, the confirm gate, non-root); that is a manual check, not CI. CI only greps the compose file for the loopback-only port.
- The e2e script needs a hostile-mcp checkout, git, npm and a Playwright Chromium; it is documented, not run by CI.
- The optional live hostile-server test (`hostile.integration.test.js`) is skipped, with `SKIPPED: set HOSTILE_MCP_SRC` in its title, when no `hostile-mcp` checkout is next to this repo, so CI does not run it. The criterion itself does not depend on it: the committed-snapshot test above always runs. The snapshot can go stale; it is not refreshed automatically.

## Entitled listing and aggregate cap (Ping release claim, simulated)

**Ping release claim (2026-11-02), UNVERIFIED on our tenant.** The Entitled listing page and the third run on the diagram simulate what Ping's release is said to add to MCP gateways: a tool the caller is not entitled to is removed from `tools/list` and refused again when called by name, and an aggregate of member MCP servers (tools named `alias__tool`) has one policy that caps every member, enforced on the listing and again at the member hop. An unreachable member is reported, not dropped. In **Mock** it is a simulation in this process (no socket, no outbound call). In **Real** (header toggle) the page asks your own gateway's MCP aggregate apps with your agent keys: it compares what each app lists, and calls a hidden name to see the refusal (never a listed tool; those go through the Server page's confirm dialog). Set `MCP_TOOLS_GW_URL`, `MCP_TOOLS_GW_APPS` and one `MCP_TOOLS_GW_KEY_<NAME>` per caller in `~/Development/.env` (see `docs/entitled-listing.md`). The hosted mock has no Real. A banner says so on every tab and in presenter mode.

A scan of a filtered list covers only what that caller sees, so a clean result is not clean for other callers; the scan notes and the Limits page say so. Names from the console swagger (`Members`, `AppRef`, `Alias`, `ToolFilter`, AppType `mcp-aggregate`) are tagged as schema names only; the entitlement behaviour and the cap have no swagger field and are tagged as deck claims. Full tagging, the talk track and the tests: [docs/entitled-listing.md](docs/entitled-listing.md). `npm run mutate` checks that each policy field and rule is really tested.

## Live proxy (flow log)

The Live proxy page turns this tool into a local debugging passthrough, so you can see what an agent really sends. Turn it on, copy the `claude mcp add ...` command shown for a server, and use that server from Claude Code (any MCP client that can send a header works). Every JSON-RPC message then shows up in the Live flow table with route, method, status, time and an estimated token cost in each direction; open a row to see the headers and both bodies.

- One URL per server on this tool's own port: `http://127.0.0.1:4810/proxy/mcp/<id>`. No extra port.
- Off by default. Turning it on mints a random proxy token that the client sends as `Authorization: Bearer ...`; turning it off, Reset or a restart ends it and closes open streams. The token keeps out web pages, not programs already running as you on this machine. The client's header is never forwarded: the server gets the saved connection's own credential, which stays write-only, and is scrubbed out of what the client gets back and out of the flow log.
- Mock mode offers the two built-in sample servers only, answered in this process. Real adds your saved servers: http servers are a raw passthrough (SSE streams included, redirects refused); stdio and PingOne connections are bridged through this tool's own client.
- It is not a gateway and enforces no policy. **The confirm step of the Server page does not apply to calls an agent makes through the proxy.**
- The log keeps the last 200 flows in memory only, bodies capped at 64 KB. Token counts are characters / 4, an estimate and not a tokenizer.
- Not built: one aggregate URL for all servers, and running OAuth for the client (a server that needs an OAuth sign-in has to be saved with a token first).

### Saved inputs and token estimates

- **Saved inputs:** on the Server page, after picking a tool, give the current arguments a name and press Save input; Load puts them back in the form. A `tools/call` captured by the live proxy can be saved the same way (Save as input in the flow detail, Real mode, saved connections only). Loading only fills the form: Review call and the confirm step still apply. Calls (and so saved inputs) unlock after a scan of the server in this session; the call panel has its own Scan now button. Each tool card has a **Run** button that picks that tool in the call panel and scrolls to it; it sends nothing, and Review call and the confirm step still apply. They live in `inputs.json` next to `connections.json` (mode 600), at most 50 per connection, and go when the connection is deleted or on Reset. A mock-only copy refuses to save them.
- **Token estimates:** each tool, resource and prompt shows `~N tokens`, the Tools tab shows what the whole `tools/list` costs an agent's context before it calls anything, and a call result shows its own cost. The proxy's flow log shows both directions. All are characters / 4: an estimate, not a tokenizer.

### Flags and the review brief

Flag any tool, resource or prompt on the Server page with a note, then press **Download review brief (Markdown)** (it works with nothing flagged too, and then lists every scan finding): a `.md` file for a coding agent or a reviewer with your notes, the server's own definitions, the scan findings (flagged items first, the rest after) and the token cost. Every piece of server text, and every note, sits in a fenced block that no backtick run in the text can close, with invisible characters shown as `[U+XXXX]`, under a header that says it is untrusted data. The brief is built in the page from what this session listed and scanned. Flags are stored like saved inputs (`flags.json`, mode 600), one per item, and go with the connection and on Reset; a mock-only copy refuses them. A flag changes nothing on the server and blocks nothing.

Checked by hand on 2026-11-07: the official MCP Inspector CLI (`@modelcontextprotocol/inspector` 2.14.0, `--cli --transport http --header`) listed tools and called a tool through the proxy, and was refused without the token.

## Run it

Run from a clone of https://github.com/curtismu7/mcp-tools-LAB (Node 26 or newer):

```bash
npm install
npm run doctor     # node, bind, state dir mode, port; prints no secrets
npm test           # server (node:test) and web (vitest)
npm run build
npm start          # http://127.0.0.1:4810/ (PORT to change)
npm run dev        # API on 4810, Vite on 4811
```

`npm start` serves the built UI from `web/dist`, so run `npm run build` first. Ports start at 4800 so they stay clear of the other demos.

### Our servers (Connect page)

The Connect form opens with an **Our servers** dropdown. Each entry says whether it is running right now (a bare TCP connect to a loopback port; nothing is sent). Choosing one fills the name, URL and auth header; for one that is running you only press **Connect and test**. For one that is not, the page shows the command that starts it and a **Check again** button.

The list is `server/data/known-servers.json`: loopback `http` servers with an explicit port, no credentials (the loader refuses anything else, and a test pins the committed file). It ships with the Everything reference server (`:4730`), the live hostile-mcp (`:4701`), AI-DEMO2's banking MCP server (`:8080`), banking resource server (`:8081`), weather (`:8896`), Brave (`:8897`), audit (`:8898`), JWT verifier (`:8083`) and MCP gateway (`:3005`), and the SE cluster's OpenSearch MCP through a port-forward (`:9900`). An entry with `needsToken` is one that refuses a tokenless request: the page fills everything else and leaves the Auth header value for you. Add an entry there to add a server. In Docker, "loopback" is the container, so servers on your host show as not running; run the lab on the host (`npm start`) to use the dropdown with them. The hosted mock lists none.

### What to do if the port is taken

Host run: `PORT=4820 npm start` (any free port; `npm run doctor` tells you whether 4810 is free). Docker: `HOST_PORT=4820 docker compose up --build -d`; the container port stays 4810 and only the host side moves. Then open that port, and check `GET /api/health` on it.

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
- The live proxy is off by default, needs its own per-session token on every request, refuses a browser `Origin` from another site, never forwards the client's `Authorization` header and never logs either token. The confirm gate does not cover calls made through it.

More in [docs/security.md](docs/security.md).

## Optional: PingOne hosted MCP (off by default, untested here)

`MCPTOOLS_PINGONE=1` adds a "PingOne hosted" connection type: Authorization Code + PKCE (with PAR) against **your own** PingOne OIDC app, then PingOne's hosted MCP server as one more connection with the same scan, call and confirm path. You must set `PINGONE_ENVIRONMENT_ID` and `PINGONE_MCP_CLIENT_ID` (there are no built-in defaults), register `http://127.0.0.1:PORT/api/pingone/callback`, and accept that this path has **not been exercised against a real tenant** in this repo. With the flag on and the ids missing, `/api/health` reports `needs-setup`.

`MOCK_ONLY=1` (also `true`, `yes`, `on`, any case) is the hosted-mock switch. `0`, `false` or unset is off. Any other value (a typo such as `True1`) makes the app refuse to start, so a hosted copy can never silently fall back to live mode: the server connects only to its two built-in sample servers (answered in-process, no sockets), refuses any URL, token, stdio command or PingOne request with `403 {error:"mock_only"}`, stores and reads nothing on the host, ignores `.env`, shows a banner, and `/api/health` reports `mode: "mock-only"`.

The hosted hostile fixture serves only the first tools list (`toolsList1`), so the rug-pull (the changed second list) is not shown in the hosted mock; run the live hostile-mcp server locally to see it.

### Hosting the mock

Defaults stay loopback-only. A hosted copy opts in explicitly, with all three:

```
MOCK_ONLY=1
MCPTOOLS_BIND=0.0.0.0                       # listen on all interfaces (the image already sets this; a bare `node` run does not)
MCPTOOLS_ALLOWED_HOSTS=mock.mcp-tools.example     # comma-separated public Host name(s) the ingress forwards
```

`PORT` (default 4810) sets the port. Any other `Host` header gets `403 bad_host`, and with `MCPTOOLS_BIND` set but no allowed host the app answers only loopback names. The deploy script must assert, after rollout, that `GET /api/config` returns `mockOnly:true` and `stdio:false` (and `/api/health` `mode:"mock-only"`), and fail the deploy otherwise. Readiness probe: `GET /api/health` (contract `demo-health/1`, `mode: "mock-only"`). A probe sent to the pod IP carries that IP as its `Host` and is refused, so set the probe's `Host` header to the allowed name (Kubernetes `httpGet.httpHeaders: [{name: Host, value: mock.mcp-tools.example}]`) or to `127.0.0.1`. Do not bake a `.env` into the image or build context: the image copies `server/src` and the built web app only, and `MOCK_ONLY=1` ignores `.env` anyway; pass settings as environment variables. Tests: `server/test/hosting.test.js`.

## Docker

```bash
HOST_PORT=4820 docker compose up --build -d      # http://127.0.0.1:4820 (HOST_PORT defaults to 4810)
docker compose down
```

The image runs as a non-root user. Inside the container the server listens on all interfaces (`MCPTOOLS_BIND`); `docker-compose.yml` publishes `127.0.0.1:HOST_PORT:4810` only, and a test fails if that changes. **stdio connections launch the command you type inside the container**, not on your machine; to scan a stdio server on your machine run the app on the host. Details: [docs/packaging.md](docs/packaging.md).

## SE shelf, Learning Hub, browser run

- Shelf: `docs/shelf-entry.json` registers this app (D3 and D4, one app; tag `mcp-server-built`; it shows Ready from `/api/health`). `composeFile` in it is relative to the shelf's demo root, the folder that holds this checkout as `mcp-tools-LAB`.
- Learning Hub: `content-pack.json`, regenerate and validate with `npm run content-pack`.
- Browser run: `npm run build && npm run e2e` (needs a `hostile-mcp` checkout next to this repo; see [docs/packaging.md](docs/packaging.md)).
- Diagram drag check: `npm run build && npm run diagram-check` drags every box on every run at 1440 and 375 wide and fails if an edge label lands on a box or another label (a real browser; not part of `npm test`).

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
