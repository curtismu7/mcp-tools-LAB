# Security rules and the tests that enforce them

This tool connects to servers the operator names, so each rule below has a test. Server tests are `node --test` files in `server/test/`; web tests are vitest files under `web/src/`. `npm test` runs both.

| Rule | Where | Test |
| --- | --- | --- |
| Binds loopback unless `MCPTOOLS_BIND` is set | `server/src/security.js` (`assertBindAllowed`) | `security.test.js` "bind: loopback by default, anything else needs MCPTOOLS_BIND"; `doctor.test.js` "a non-loopback bind without opt-in fails" |
| Rejects a non-loopback `Host` header (DNS rebinding) | `hostCheck` | `security.test.js` "Host check"; `api.test.js` "a non-loopback Host header is refused" |
| Any state-changing endpoint is same-origin only (`Origin` equals `Host`) | `sameOriginWrites` | `security.test.js` "same-origin writes"; `api.test.js` "state-changing calls without a same-origin Origin are refused and change nothing" |
| Saved connections live in `~/.mcp-tools` or `DATA_DIR`, file mode 600 in a mode 700 directory | `store.js` | `store.test.js` "http connections persist with mode 600 in a mode 700 directory"; `doctor.test.js` "a state directory or connections file with group/other access fails" |
| A token is never returned by an API, logged, put in a trace or shown in the UI (it shows `set`) | `store.publicView`, `redact.js`, `app.js` | `api.test.js` "create + test" and "a server that echoes the token in a tool result does not get it back"; `store.test.js`; web `connect.test.jsx` "connects with a write-only token, clears the field, never shows it back" |
| `tools/call` from the UI needs an explicit confirm that shows the exact arguments | `canonical.js`, `app.js` gate, `web/src/components/CallPanel.jsx` | `api.test.js` "tools/call is confirm-gated: no confirm 428, wrong or stale hash 409, correct hash runs it once"; web `server.test.jsx` "builds the form from the schema, previews, requires a click in the dialog" and "Cancel and Escape send nothing"; the e2e run (`docs/packaging.md`) checks Cancel sends nothing against a real server |
| `logging/setLevel` (state-changing) is gated the same way | `mcp/methods.js` | `api.test.js` "protocol methods" |
| A scanner finding never changes a server's data; a scan never calls a tool | `scanner/live.js` | `api.test.js` "POST scan reads metadata, flags the poison, and never calls a tool"; `clients.test.js` "collectFromClient ... never calls a tool"; `hostile.fixture.test.js` (always on), `hostile.integration.test.js` (optional, live) |
| stdio launches only a command the operator typed in the UI this session, never one from a server's response; no shell | `store.js`, `mcp/stdio.js` | `store.test.js` "stdio connections are session-only"; `clients.test.js` "stdio: no shell, minimal environment ..." and "a shell metacharacter in the command is a literal file name"; `api.test.js` "stdio: created only by an operator POST" |
| Server redirects are never followed (an auth header must not travel) | `mcp/http.js` | `clients.test.js` "http: a redirect is not followed" |
| Everything from a server renders as inert text; strict CSP and hardening headers | `web/src/lib/Untrusted.jsx`, `app.js` | web `untrusted.test.jsx`; `api.test.js` "responses carry the hardening headers that keep untrusted text inert"; web `server.test.jsx` "lists tools and schemas as inert text" |
| Hostile input (huge, deeply nested, cyclic-looking JSON) is reported, not a crash | `scanner/engine.js` | `scanner.test.js` "deep nesting ends in a scan-truncated finding", "a huge schema stops at the node budget", "a cyclic object ... is detected", "odd shapes do not throw"; `api.test.js` "offline scan ... hostile shapes are handled" |
| Unicode tricks (zero-width, bidi, tag characters, homoglyphs) are reported with the characters made visible | `scanner/unicode.js` | `scanner.test.js` "invisible characters are reported with the characters made visible", "bidi controls are high ...", "homoglyphs ..."; web `untrusted.test.jsx`; the e2e run checks `[U+200B]` and `[U+202E]` on screen |
| The container publishes its port on `127.0.0.1` only, runs as non-root | `docker-compose.yml`, `Dockerfile` | `packaging.test.js` "docker-compose.yml publishes only on 127.0.0.1", "the image is Node 26 and runs as a non-root user" |
| The page makes no request outside its own origin | `web/` | the e2e run (not CI) fails on any request outside the app origin |

Known edges, stated plainly:

- The tool connects to any URL the operator types, including loopback and private addresses. That is its job; it is not an SSRF-hardened proxy, which is why it binds loopback and checks `Host` and `Origin`.
- The confirm step is a contract of the API and the UI. A script on this machine that passes the same-origin check can call the preview endpoint and then the call endpoint. The step protects against a click you did not mean and against changed arguments, not against a hostile local process.
- The UI gates calls behind a scan; the API does not (a scan is not a permission).
- A token is stored in clear in the mode 600 file so calls can authenticate. The file is as safe as your home directory.
- If a token is shorter than four characters it is not redacted.
- **In Docker, stdio connections launch processes inside the container**, with the container's network. The container is read-only, drops all capabilities and publishes on loopback only, but it is the operator's typed command that runs.
- The scan rules are heuristics; see [scan-rules.md](scan-rules.md) for what each one misses.
