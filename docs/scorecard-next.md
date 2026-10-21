# Groundwork for D35 (MCP authorization conformance scorecard)

A note only. **Nothing in the scorecard is built here.** D35 (the plan's catalog row: score PRM per RFC 9728, `WWW-Authenticate` scope, authorization-server metadata, CIMD/DCR, PKCE S256, `resource`, `iss`, 403 `insufficient_scope`, spec-version negotiation) is a different question from D3 (inspect) and D4 (risky tools): is the server's *authorization* conformant. It could reuse these parts of this repo.

## What it would reuse

| Part | Where | Reuse |
| --- | --- | --- |
| Result shape `scan-report/1` and its schema | `server/src/scanner/report.js`, `docs/scan-report.schema.json` | A scorecard report is the same idea (checks with id, severity, evidence, a limits list, `enforcement: none`). Copy and rename to a `scorecard-report/1`; keep the "what this cannot catch" list. |
| Rule table with stable ids and fixed severity | `server/src/scanner/rules.js`, `scripts/build-scan-rules.mjs` | Same table-plus-generated-doc pattern, one id per spec requirement, with "what it misses" per check. |
| Evidence spans and visible-character excerpts | `server/src/scanner/engine.js`, `unicode.js` | Quote the offending header or metadata field; `visible()` for header values. |
| HTTP client with no redirects, size and time caps, SSE handling | `server/src/mcp/http.js` | Probing `/.well-known/oauth-protected-resource` and an unauthenticated `initialize` for the 401 and `WWW-Authenticate`. Redirects must stay refused (an auth header must not travel). |
| Connection store, token redaction | `server/src/store.js`, `redact.js` | A scorecard that is given a token must treat it the same way. |
| Loopback bind, Host and same-origin guards | `server/src/security.js` | The tool connects to operator-named URLs; the same SSRF-adjacent caveats apply (see `docs/security.md` known edges). |
| Health contract, doctor, shelf entry, content pack, Docker, e2e | `server/src/health.js`, `docs/shelf-entry.json`, `scripts/` | Unchanged conventions. |
| CLI with exit codes | `server/src/scanner/cli.js` | The "CI-able" part: `--json`, `--fail-on`, exit 0/1/2. |
| Web shell: Connect page, report view, limits page, stories, ReactFlow diagram | `web/src/` | A scorecard page can sit beside Scan. |

## What it would need that does not exist here

- Unauthenticated probing (a 401 with metadata) and OAuth discovery requests: this tool only sends authenticated or anonymous MCP JSON-RPC.
- A rule source for each requirement with a verified spec reference. The plan marks the 2026-07-28 release candidate as unverified externally; verify before any check claims it.
- Overlap with D2 (MCP auth lab) and C20 (OAuth profile checker) is called out in the plan; decide the shared engine before writing a third.

Nothing above is a commitment; it is what is already here that a scorecard would not have to rebuild.
