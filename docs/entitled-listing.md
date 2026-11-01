# Entitled listing and aggregate cap (Ping release claim, simulated)

**Ping release claim (2026-11-02), UNVERIFIED on our tenant.** The SE gateway is v1.261030 and does not have this release. Nothing here was measured against a gateway. The Entitled listing page and the third diagram run simulate the claim in this process so a presenter can show its shape. There is no live path for it in this app until the release is on our tenant; the app is the live inspector (or the hosted mock when `MOCK_ONLY` is set), and the simulation behaves the same in both because it never opens a socket.

## What is simulated

1. **Entitlement-aware discovery.** A tool the caller is not entitled to is removed from `tools/list`, not only refused when called. The list does not say how many tools were left out.
2. **Refused again by name.** The same tool, called by name, is refused. A hidden tool and an unknown tool get the same words.
3. **The aggregate and its policy cap.** An aggregate of member MCP servers names each member tool `alias__tool`. The aggregate's policy caps what any member tool may be used for. The cap is enforced on the listing and again at the member hop. A cap only removes: a tool the member denies stays denied.
4. **Unreachable member reported.** A member that cannot be reached is reported in the listing, not silently dropped. A member that needs the caller's own upstream sign-in is reported as needing it, and offers that caller nothing until then.
5. **Direct use follows the member.** The same tool reached through the member directly follows the member's own policy only (no cap, no ToolFilter). This is the negative control.

Layers a tool can be stopped at, checked in this order: `unreachable`, `upstream-sign-in`, `tool-filter`, `member-policy`, `aggregate-cap`. Default is deny: a caller with no entry in a policy or the cap gets nothing.

## How every name is tagged

| Tag | Meaning |
| --- | --- |
| console swagger name, 2026-10-31, schema only | The name exists in the console API schema. Nothing was called. |
| deck claim, UNVERIFIED on our tenant | The release deck says so. There is no swagger field for it. |
| lab reading | Our interpretation of a schema name or a deck sentence. |
| lab-invented | A shape this lab made up so it can show the claim. |

| Name or claim | Tag |
| --- | --- |
| `mcp-aggregate` (AppType value) | console swagger name |
| `Members` (on `modelMcpAppConfig`, wrapped by `modelMcpAggregateMembers`) | console swagger name; existed on 2026-10-26, not new |
| `AppRef`, `Alias`, `ToolFilter` (`modelMcpAggregateMember`) | console swagger name; existed on 2026-10-26, not new |
| `alias__tool` naming | console swagger name (from the schema description) |
| `ToolFilter` as an allow-list | lab reading (the schema gives only a name and a string-array type) |
| entitlement-aware discovery; removed from the list and refused by name | deck claim (slide 36). **No swagger field.** |
| aggregate policy cap; cap enforced twice | deck claim (slide 37). **No swagger field, so no field name is given to it.** |
| unreachable member reported; per-user upstream sign-in | deck claim (slide 37); the status words and the yes/no model are lab-invented |
| member policy (per-caller tool lists) | lab reading |
| `gateway-claim/1` config, caller ids, layer names, demo trace | lab-invented |

The API object stays `NonHumanIdentity`; Federated Identity is a display name only. Callers in this lab are plain labels, not identities. The committed excerpt `server/test/fixtures/swagger-excerpt-2026-10-31.json` holds the schema text the swagger-tagged names come from; `SWAGGER_FILE=<path> npm test -w server` also checks the full file for any cap or entitlement property (there is none).

## Talk track (Challenge, Technical, Business: Ping claims)

Put the Challenge line first. These are paraphrased from the deck's value panels and are Ping claims, UNVERIFIED on our tenant.

| Feature (slide) | Challenge | Technical value | Business value |
| --- | --- | --- | --- |
| MCP Gateway (36) | One shared token and every tool exposed to every caller: no attribution, no per-tool control, so security stalls adoption. | Per-user identity, per-tool policy and injected credentials on every call, fully audited. | MCP integrations proceed under existing governance; faster time to value on agent projects. |
| MCP Aggregate (37) | Each agent-server pair needs its own connection, config and credential, so effort and attack surface grow with each pair. | One connection, one policy cap enforced twice, one audit trail across members. | New servers join by configuration, not project work: lower per-integration cost, faster rollout. |

The story MT3 on the Stories page walks this in six steps. The same text is in `content-pack.json` as the `why-mcp-gateway` and `why-mcp-aggregate` entries.

## The scanner caveat

A scan of an entitlement-filtered list covers only what that caller sees. A tool hidden from this caller was never scanned, so a clean result is not a clean result for any other caller. The scan notes on the page say how many tools that caller sees, and the Limits page carries the `filtered-listing` limit. In the default fixture the Operator sees a tool with a planted hidden instruction when the member is used directly, and does not see it through the aggregate: the scan is clean in one view and not in the other.

## Run and test

- Open the Entitled listing page. Pick a caller, call a tool you were not shown, edit a policy box, press Scan, press Reset.
- The simulation is in `server/src/gateway/` (`sim.js` the engine, `config.js` the validation, `routes.js` the `/api/gateway/*` routes, `provenance.js` the tags). It is pure and stateless: the browser sends the config it is editing with each request, nothing is stored on the host, and no outbound call exists.
- Tests: `server/test/gateway.engine.test.js` (each row of the plan with a negative control), `server/test/gateway.api.test.js` (HTTP, hostile input, credentials never echoed, zero outbound, mock-only, tags), `server/test/gateway.credentials.test.js` (every credential rule and every place a credential can be typed, including a tool inputSchema), `web/src/pages/__tests__/gateway.test.jsx` (banner, page, diagram, Reset; against the real engine).
- Mutation check: `npm run mutate` applies one fault at a time to the engine and the page and expects a test to fail for each.
