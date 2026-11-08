# Rule 16 waiver: browser OAuth sign-in for third-party MCP servers

**Owner decision, 2026-11-07.** Rule 16 of the standalone rulebook says "Login is pi.flow only: no redirect login fallbacks." This app makes one recorded exception.

## What the exception covers

- **Only third-party MCP servers.** The server's own 401 names its authorization server (RFC 9728 protected-resource metadata). The tool runs the authorization code flow with PKCE S256 in the operator's browser for that server only (`server/src/oauth.js`, Server page "OAuth sign-in").
- **Never Ping.** An authorization server on a Ping host (`pingone.*`, `pingidentity.com`, `ping-devops.com`, any host naming PingOne or PingFederate) is refused with a message that says Ping sign-in is pi.flow only. This is a host-name check (case and a trailing dot ignored) applied to the issuer and to the authorization, token and registration endpoints, so a non-Ping issuer cannot front a Ping endpoint. A Ping server behind another name is not recognised, so the habit stays the same: sign in to Ping with pi.flow.
- **Not the app's own login.** This app has no login of its own; nothing here changes how the family's demos sign people in.

## Why

pi.flow is a Ping response mode. A third-party MCP server's authorization server cannot drive it, so without a redirect sign-in the inspector and the live proxy could not reach any OAuth-protected server except by pasting a token obtained elsewhere.

## Guards

- `resource` set to the MCP server (RFC 8707); single-use state that expires after 10 minutes; the callback's `iss` checked when sent (RFC 9207); the metadata issuer must match; PKCE S256 required.
- Every URL a server hands us is https, or http on a loopback host; redirects are not followed; replies are read with a 64 KB byte limit and a 10 s timeout. **Not guarded:** an https name that resolves to a private or link-local address (there is no DNS or IP check and no pinning), so a hostile MCP server could make this local tool contact an address on your network. The operator names the servers; do not point it at servers you do not trust.
- The callback's `iss` is required when the authorization server says it sends one, and a repeated `iss` is refused.
- Tokens, refresh tokens and any client secret stay in process memory only: never returned by an API, never logged, never written to disk, gone on restart, Reset or sign-out. A server that echoes the token gets `[redacted]`.
- Mock-only copies refuse it.

Tests: `server/test/oauth.test.js` (a fake authorization server and a fake protected MCP server on loopback) and web `oauth.test.jsx`.
