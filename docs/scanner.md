# The scanner

A scan reads the metadata an MCP server serves, before an agent ingests it, and reports what looks like poison. **It reports; it never blocks**, never calls a tool and never changes a server's data. Code: `server/src/scanner/`.

## Rules

Each rule has a stable id and one fixed severity (`info`, `warn`, `high`). The table is `server/src/scanner/rules.js`, also served by `GET /api/rules` and shown on the Limits page. Ids never change meaning. The full table, with where each rule looks and what it misses, is generated: [scan-rules.md](scan-rules.md).

The first three kinds and their patterns are the original `mcp-scanner` behaviour. The library also exports `scan`, `scanResources`, `scanPrompts` and `scanAgentCard` with the original `[{tool, kind, detail}]` shape (one entry per tool, argument and kind), and the original tests run against them unchanged (`server/test/scanner.legacy.test.js`). One deliberate fix: the source treated `http://[::1]/` as off-box (an IPv6 hostname keeps its brackets); it is now loopback.

**Trusted names** are the tool names you already trust from *other* servers (`--trusted`, or the field in the UI). Scanning a server against its own names flags everything, so do not.

## Evidence

Every finding names the `field` (a path such as `inputSchema.properties.callback_url.default`), `start` and `end` (UTF-16 code-unit offsets into the original string, the offsets `String.prototype.slice` uses), and an `excerpt`. The excerpt is plain text with invisible characters shown as `[U+200B]`; it is never HTML and nothing is escaped or wrapped. The UI renders it as text nodes and highlights the span.

## Budgets

Hostile input ends in a `MT-LM-001` finding, not a crash. Defaults (`DEFAULT_BUDGET` in `engine.js`): depth 32, 20,000 values, 1,048,576 characters in total, 20,000 characters per string, 500 findings. A cyclic in-memory object is detected, not followed. The offline endpoint also caps the request body (`MCPTOOLS_SCAN_MAX_BYTES`, default 1 MiB) and answers 413 beyond it.

## The report: scan-report/1

`buildReport` and `--json` produce [scan-report/1](scan-report.schema.json): `scannedAt`, `scanner` (with `enforcement: "none"`), `source`, `input` counts, `summary`, `findings` (worst first), the `rules` table and the `limits` list. The same limits text travels in every report.

## What a metadata scan does NOT catch

- **Result-based injection.** A tool with clean metadata whose call result carries the instruction. The scan never calls a tool.
- **Rug-pulls after the scan.** A server can serve a clean list now and a poisoned one later. A scan is one list at one moment. The integration test shows it: the hostile server's `get_stock_price` is clean on the first list and flagged on the second. Re-scan, or pin hashes of what you approved.
- **Poisoned resources and prompts you did not fetch.** The live scan reads the content of the first 25 resources and prompts the server lists; an offline snapshot only has what you pasted.
- **Novel phrasing**, another language, or an instruction split across fields. The rules are heuristics; an unusually worded legitimate tool can also trip one. The false-positive rate on real servers is not measured.
- **Whether a clean tool should be allowed at all**, or what it does when called. A clean scan is not proof of safety. Controlling the call path is a separate layer (the Privilege demo).

## Live scans read; they do not execute

A live scan runs `initialize`, `tools/list`, `resources/list`, `prompts/list` and, unless turned off, `resources/read` and `prompts/get` for what the server listed (prompt arguments are filled with `demo-value`). It never sends `tools/call`. The tests assert that.
