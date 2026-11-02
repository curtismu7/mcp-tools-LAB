# CLAUDE.md: MCP tools LAB

Tier: Tester. Connect to an MCP server, list what it offers, scan the metadata for poison before an agent ingests it, and only then call tools behind an explicit confirm. Repo: https://github.com/ping-sandbox/mcp-tools-LAB. Read `README.md` and `docs/security.md` first; the rulebook is `~/Development/STANDALONE-RULES.md` (skill `standalone-demo`).

## Run and test
- Needs Node 26 or newer. `npm install`, `npm run doctor`, `npm test` (server `node:test`, web vitest, the forbidden-strings gate test), `npm run build`, `npm start` (`127.0.0.1:4810`, `PORT` to change). Docker: `HOST_PORT=4820 docker compose up --build -d` publishes `127.0.0.1` only. Run suites on the Air (`air-test`), not on this Mac.
- `npm run e2e` and `npm run diagram-check` need a real browser (and a `hostile-mcp` checkout for e2e); run them locally.
- `GET /api/health` answers `demo-health/1` for the shelf.

## Rules that bite (each has a test; do not weaken)
- Binds `127.0.0.1`; a loopback `Host` header and a same-origin `Origin` on every state-changing call. A token is never returned, logged or shown. `tools/call` needs `confirm` plus the hash of the arguments the operator saw. A scan never calls a tool and never blocks anything.
- The simulated gateway's credential check (`server/src/gateway/`) must never echo a submitted credential; a change there needs the corpus, fuzz and ReDoS scripts in `package.json` and the documented limits in `docs/credential-check.md` kept true.
- UI: the vendored `web/src/standalone-ui.css` must stay byte-identical to `~/Development/AI-DEMO-Standalone/shared/standalone-ui.css`; no local colour literals (use its tokens), no `prefers-color-scheme` outside it, no `!important`. Run `check-css.sh` and `check-drift.sh` from the parent repo before a PR. There is no Mock/Real toggle by owner decision (stylesheet and CSS checks only).
- Product claims about the Ping release are simulated and UNVERIFIED on our tenant; say so. Never say "door" (say P1 Privilege Agent App).
- The forbidden-strings gate (`npm run check:forbidden`, CI job `forbidden-strings`, secret `FORBIDDEN_STRINGS`) prints counts only. CI is GitHub-hosted, Node 26 only: build, forbidden-strings, gitleaks. Docker is OrbStack, never Docker Desktop. The SE k8s mock build is deferred.
- Commits end with the Co-Authored-By line from the session's attribution reminder.

## Shelf
`docs/shelf-entry.json` registers the app (D3 and D4, one app; tag `mcp-server-built`).
