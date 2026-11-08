# HTTP API

Every request needs a loopback `Host`. Every non-GET needs `Origin` equal to `Host`. Bodies are JSON.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | `demo-health/1`. Public, GET only, state from the doctor checks cached 60 s. |
| `GET /api/config` | Limits and whether the optional PingOne connection is on. |
| `GET /api/rules` | The rule table and the limits list. |
| `GET /api/protocol-methods` | The protocol methods besides `tools/list` and `tools/call`. |
| `GET /api/connections` | Saved connections. A token shows as `"set"`; stdio env shows keys only. |
| `POST /api/connections` | `{transport:'http'\|'stdio'\|'pingone', label, url, authHeader, token, command, args, env}`. Saves, then tests (`initialize`). Returns `{connection, test}`; the token is never returned. |
| `POST /api/connections/:id/test` | Re-test. |
| `DELETE /api/connections/:id` | Remove (and close). |
| `GET /api/connections/:id/tools` | `tools/list` (all pages). |
| `POST /api/connections/:id/scan` | `{trustedNames?, fetchContent?}`. Lists tools, resources, prompts from the live server and scans what it received. Never executes anything. Returns `{report: scan-report/1, listed}`. |
| `POST /api/scan` | `{snapshot, trustedNames?}`. Offline scan of a pasted `tools/list` snapshot (string or object). Size capped (413). |
| `POST /api/connections/:id/call/preview` | `{tool, arguments}` returns `{canonical, argsHash}`: the exact text to show the operator. |
| `POST /api/connections/:id/call` | `{tool, arguments, confirm:true, argsHash}`. 428 without confirm, 409 on a hash mismatch. |
| `GET /api/gateway/default` | The default simulated-gateway config, the tag vocabulary and the claim label. Ping release claim (2026-11-02), listing and cap measured on gateway v1.261106 (2026-11-08), per-caller entitlement UNVERIFIED on our tenant. |
| `POST /api/gateway/list` | `{config?, caller, view?: 'aggregate'\|'direct', member?}` returns the tools that caller sees and the member status. Hidden tools are absent and not counted. |
| `POST /api/gateway/call` | `{config?, caller, view?, member?, tool, arguments?}`. 200 for an allowed tool, 403 `tool_not_available` with the same words for a hidden or unknown one, plus a labelled demo trace. |
| `POST /api/gateway/audit` | Same body as list. Names every tool and the layer that stopped it. Demo only: a caller never sees this. |
| `POST /api/gateway/scan` | Same body as list. Scans the listing as that caller sees it; the notes say the scan covers only that. |
| `POST /api/connections/:id/rpc[/preview]` | `{method, params}` for a protocol method; `logging/setLevel` is confirm-gated like a call. |

`argsHash = sha256(connectionId \n method \n name \n canonicalJson(arguments))`, where canonical JSON sorts object keys at every depth.

Errors are `{error, message}`; `message` never contains a token. The `/api/gateway/*` routes are stateless, in-process and work in mock-only mode; they refuse any field they do not list and never repeat a typed value (details: [entitled-listing.md](entitled-listing.md)).
