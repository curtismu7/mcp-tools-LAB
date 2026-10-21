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
| `POST /api/connections/:id/rpc[/preview]` | `{method, params}` for a protocol method; `logging/setLevel` is confirm-gated like a call. |

`argsHash = sha256(connectionId \n method \n name \n canonicalJson(arguments))`, where canonical JSON sorts object keys at every depth.

Errors are `{error, message}`; `message` never contains a token.
