# Changelog

## 0.1.0

- MT0: scaffold; the inspector and scanner ported from AI-DEMO2 `standalone/mcp-inspector` and `standalone/mcp-scanner`; connections, scan, confirm-gated call, `GET /api/health` (`demo-health/1`), doctor.
- MT1: web app (connect, server tabs, scan result, confirm dialog, offline scan, two stories, ReactFlow diagram, limits).
- MT2: `docker-compose.yml` (port published on loopback only); SE shelf entries for D3 and D4 (`docs/shelf-entry.json`); Learning Hub content pack (`content-pack.json`, generator, ajv validator, schema copied from the ID-JAG kit); Playwright e2e against a clean copy of the real hostile-mcp server and a benign fixture (`npm run e2e`, not CI); generated `docs/scan-rules.md`; docs for architecture, packaging, pairing with the Hostile MCP and Privilege demos, D35 groundwork (`docs/scorecard-next.md`, a note, nothing built); `docs/security.md` mapped to named tests.
