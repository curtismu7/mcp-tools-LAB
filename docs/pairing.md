# How this fits with the other demos

| Layer | Job | Where |
| --- | --- | --- |
| **Inspector** (this repo) | **See** what a server offers and call it, behind a confirm step. | MCP tools |
| **Scanner** (this repo) | **Judge** the metadata before an agent ingests it. Reports; never blocks. | MCP tools |
| **Hostile MCP** | **The attack**: a server built to be scanned and pinned against. | `hostile-mcp` repo (catalog D6) |
| **Privilege demo** | **Control** the calls: who may call what, with which limits, on the wire. | separate product |

## With the Hostile MCP demo: scanning and pinning

Run the Hostile MCP server on a free port, connect to its `/mcp` address, press Scan: the poisoned tools (instruction tag, secrecy, off-box defaults, shadowing, credential harvest, the poisoned resource and prompt) are flagged with evidence and the clean ones are not. The always-on test `server/test/hostile.fixture.test.js` does this against a committed snapshot of the real server, and the optional `hostile.integration.test.js` and the e2e run do it against a clean copy of the live one.

The two demos catch different things:

- **The scanner judges content.** It catches a poisoned description on day one. It cannot catch a clean tool that changes later, or result-based injection.
- **Pinning detects change.** The Hostile MCP demo's pinned client records a hash of each tool's name, description and input schema at approval and flags a later difference (the rug-pull). It does not judge content: a poisoned tool approved blindly stays approved.
- **This app shows only a signal, not a pin.** The Server page remembers the last list it showed *in that page session* and raises "the tool list changed" when a tool's text differs on the next list or scan. Nothing is persisted and nothing is enforced. For durable pinning use a client that stores hashes (the Hostile MCP demo's pinned client shows how).
- The honest combination: scan before the first approval (so you do not pin poison), then pin (so a change is noticed), then control the calls.

## With the Privilege demo: call control

This tool does not control calls. Its confirm step protects one operator from a click they did not mean and from changed arguments; it is not an authorisation layer and a script on the same machine can pass it. Deciding which agent may call which tool, with which limits, is what the Privilege demo does on the wire. A scan finding never changes a server's data and never stops a call; a call to a flagged tool shows the finding next to the confirm dialog and leaves the decision to you.

## With the Privilege demo: a simulated shape of the entitled listing (Ping release claim)

The Privilege demo controls calls on the wire. The Entitled listing page in this app is a **simulation** of one thing Ping's 2026-11-02 release is said to add to that layer: per-caller discovery (a tool the caller may not use is not listed and is refused by name) and an aggregate policy cap enforced on the listing and again at the member hop. It is a Ping release claim. Mock does not call a gateway; Real does, and on our SE gateway (v1.261106, 2026-11-08) it measured the listing and the cap. Per-caller entitlement (two keys, different lists) is still **UNVERIFIED on our tenant**, and the claim label stays until that passes. See [entitled-listing.md](entitled-listing.md).
