# Security rules and the tests that enforce them

| Rule | Where | Test |
| --- | --- | --- |
| Bind loopback unless `MCPTOOLS_BIND` is set | `server/src/security.js` (`assertBindAllowed`) | `security.test.js` bind; `doctor.test.js` |
| Reject a non-loopback `Host` header (DNS rebinding) | `hostCheck` | `security.test.js`; `api.test.js` "non-loopback Host" |
| Writes are same-origin only (`Origin` equals `Host`) | `sameOriginWrites` | `security.test.js`; `api.test.js` "without a same-origin Origin" |
| Connections file mode 600 in a mode 700 directory | `store.js` | `store.test.js`; `api.test.js` create + test; `doctor.test.js` |
| A token is never returned, logged, traced or shown | `store.publicView`, `redact.js`, `app.js` | `api.test.js` create + test (a server that echoes the token in its 401 and in a tool result) |
| `tools/call` needs `{confirm:true, argsHash}` | `canonical.js`, `app.js` `gate` | `api.test.js` confirm-gated (428, 409, bound to connection, nothing sent before the gate) |
| `logging/setLevel` (state-changing) is gated too | `mcp/methods.js` | `api.test.js` protocol methods |
| A scan never calls a tool or changes data | `scanner/live.js` | `api.test.js` scan; `clients.test.js`; `hostile.integration.test.js` |
| stdio only from an operator POST; no shell; minimal env; memory only | `store.js`, `mcp/stdio.js` | `store.test.js`; `clients.test.js`; `api.test.js` stdio |
| Server redirects are not followed | `mcp/http.js` | `clients.test.js` |
| Untrusted strings render as inert text; strict CSP | `web/src/lib/Untrusted.jsx`, `app.js` | `web/src/App.test.jsx`; `api.test.js` headers |
| Hostile input (huge, deep, cyclic, unicode tricks) is reported, not a crash | `scanner/engine.js` | `scanner.test.js` hostile input |

Known edges, stated plainly:

- The tool connects to any URL the operator types, including loopback and private addresses. That is its job; it is not an SSRF-hardened proxy, which is why it binds loopback and checks `Host` and `Origin`.
- The confirm step is a contract of the API and the UI. A script on this machine that passes the same-origin check can call the preview endpoint and then the call endpoint. The step protects against a click you did not mean and against changed arguments, not against a hostile local process.
- The UI gates calls behind a scan; the API does not (a scan is not a permission).
- A token is stored in clear in the mode 600 file so calls can authenticate. The file is as safe as your home directory.
- If a token is shorter than four characters it is not redacted.
