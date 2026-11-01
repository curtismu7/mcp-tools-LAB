# Changelog

## Unreleased

- Entitled listing and aggregate cap: a simulation of a Ping release claim (2026-11-02), UNVERIFIED on our tenant. `/api/gateway/*` routes, an Entitled listing page, a banner on every tab and in presenter mode, a third diagram run (with a phone layout), story MT3, content-pack terms and why-it-matters entries, a `filtered-listing` scan limit, tests with negative controls and a mutation runner (`npm run mutate`). Details: `docs/entitled-listing.md`. Fix pass: a credential typed anywhere inside a tool inputSchema is refused (bounded walk), and `gateway.credentials.test.js` plus mutants C01-C17 pin every credential rule and place.

## 0.1.0

- Review fixes 1: the scanner criterion runs on every clone against a committed hostile-mcp snapshot (`scripts/capture-hostile-snapshot.mjs`), the live test is optional and says SKIPPED loudly; per-test timeouts and cleanup so a removed confirm gate fails fast; isolated `argsHash` tests; the rug-pull banner compares the scanned list with the current one; packaging checks use committed copies with recorded source commits; README counts and the shelf `composeFile` override.

- MT0: scaffold; the inspector and scanner ported from AI-DEMO2 `standalone/mcp-inspector` and `standalone/mcp-scanner`; connections, scan, confirm-gated call, `GET /api/health` (`demo-health/1`), doctor.
- MT1: web app (connect, server tabs, scan result, confirm dialog, offline scan, two stories, ReactFlow diagram, limits).
- MT2: `docker-compose.yml` (port published on loopback only); SE shelf entries for D3 and D4 (`docs/shelf-entry.json`); Learning Hub content pack (`content-pack.json`, generator, ajv validator, schema copied from the ID-JAG kit); Playwright e2e against a clean copy of the real hostile-mcp server and a benign fixture (`npm run e2e`, not CI); generated `docs/scan-rules.md`; docs for architecture, packaging, pairing with the Hostile MCP and Privilege demos, D35 groundwork (`docs/scorecard-next.md`, a note, nothing built); `docs/security.md` mapped to named tests.
