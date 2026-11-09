// Example "on the wire" messages for the diagram and the call flow. Every host, id and signature is fake on purpose
// (example.com, sig-not-real); nothing here is sent anywhere. A token is built from its parts so the raw string and the
// decoded table can never disagree.
export const SPEC_URL = "https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization";
const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const makeJwt = (header, payload) => ({ header, payload, raw: [b64u(header), b64u(payload), "sig-not-real"] });

// Plain-language note per claim. Unknown claims fall back to a generic line.
export const CLAIM_NOTES = {
  alg: "How the signature was made. The receiver checks it with the auth server's public key.",
  typ: "What kind of token this is.",
  kid: "Which of the auth server's keys to check the signature with.",
  iss: "Who issued the token. A receiver only trusts issuers it already knows.",
  sub: "Who the token is about: the person (or app) it was issued to.",
  aud: "Who the token is FOR. A server must refuse a token whose aud is not itself.",
  scope: "What the token allows. A call needing more than this is refused.",
  exp: "When it stops working (seconds since 1970). Short lifetimes limit damage if it leaks.",
  iat: "When it was issued (seconds since 1970).",
  jti: "A unique id for this one token, so it can be tracked or revoked.",
  client_id: "Which app asked for the token.",
  resource: "The exact server the app said it wanted the token for (RFC 8707). It becomes aud.",
  act: "Who is acting for the subject. Lets the API see both who it is for and who is acting.",
  cnf: "Ties the token to one key (proof of possession), so a stolen copy is useless without that key.",
};
export const TERMS = [
  ["JSON-RPC", "the message format MCP uses: a small JSON object with a method name, parameters and an id."],
  ["Bearer token", "a pass that works for whoever holds it. It travels in the Authorization header."],
  ["JWT", "a token made of three dot-separated parts: header, payload, signature. The first two are just encoded JSON, so anyone can read them; only the signature stops forgery."],
  ["Claim", "one fact inside a token's payload, such as who it is for (aud) or when it expires (exp)."],
  ["401 and 403", "401 means 'I do not know who you are'; 403 means 'I know you, and you may not do this'."],
];

const TOKEN = makeJwt(
  { alg: "RS256", typ: "JWT", kid: "key-1" },
  { iss: "https://auth.example.com", sub: "user-123", aud: "https://mcp.example.com/mcp", scope: "tools:read tools:call", client_id: "app-example", iat: 1893452400, exp: 1893456000, jti: "tok-0001" },
);
const bearer = `Bearer ${TOKEN.raw.join(".")}`;
const HOST = "mcp.example.com";
const tok = (label, focus) => ({ label, ...TOKEN, focus });
const json = (o) => JSON.stringify(o, null, 2);

// One entry per diagram box. `traffic: false` entries say plainly that nothing is sent.
export const WIRE = {
  server: {
    title: "Connecting: the server asks who you are",
    traffic: true,
    req: { line: `POST /mcp HTTP/1.1`, headers: [`Host: ${HOST}`, "Content-Type: application/json", "Accept: application/json, text/event-stream"], body: json({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "mcp-tools", version: "0.1.0" } } }) },
    res: { line: "HTTP/1.1 401 Unauthorized", headers: [`WWW-Authenticate: Bearer resource_metadata="https://${HOST}/.well-known/oauth-protected-resource"`], body: "" },
    notice: "A protected server does not answer anonymous callers. The 401 points at a metadata document that says which auth server to ask for a token. Connecting only talks; no tool runs.",
  },
  conn: {
    title: "Connection: initialize, then list what the server offers",
    traffic: true,
    req: { line: "POST /mcp HTTP/1.1", headers: [`Host: ${HOST}`, `Authorization: ${bearer}`, "Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 2, method: "tools/list" }) },
    res: { line: "HTTP/1.1 200 OK", headers: ["Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_time", description: "Get the current time." }] } }) },
    token: tok("The token the tool sends with every request (Example)", ["aud", "scope", "exp"]),
    notice: "The server checks aud (is this token for me?), scope and exp before it answers. Listing tools is read-only: asking what exists is not the same as using it.",
  },
  scan: {
    title: "Scan: reads the list the server already sent",
    traffic: false,
    none: "The scan runs on this computer over the metadata from the step before. It sends nothing new, so there is no request to show. What it reads is the response to tools/list.",
    res: { line: "HTTP/1.1 200 OK (the earlier tools/list reply)", headers: ["Content-Type: application/json"], body: json({ result: { tools: [{ name: "get_time", description: "Get the current time. <instruction hidden from the user>" }] } }) },
    notice: "The text a server writes in a description is read by the model as if you wrote it. The scan looks for instructions hidden in it before an agent ingests it.",
  },
  findings: {
    title: "Findings: what the scan reports",
    traffic: false,
    none: "No network call here: the findings are a report made on this computer. Each has a rule, a severity and the exact text that matched.",
    notice: "'No known pattern found' only means these rules matched nothing. It does not prove the server is safe.",
  },
  you: {
    title: "Your decision",
    traffic: false,
    none: "No network call here: this is a decision a person makes. Nothing is sent until you choose to call a tool.",
    notice: "A tool should only run because a person chose it, not because software decided on its own.",
  },
  call: {
    title: "tools/call: the one message that does something",
    traffic: true,
    req: { line: "POST /mcp HTTP/1.1", headers: [`Host: ${HOST}`, `Authorization: ${bearer}`, "Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_time", arguments: { tz: "UTC" } } }) },
    res: { line: "HTTP/1.1 200 OK", headers: ["Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "2030-01-01T00:00:00Z" }] } }) },
    token: tok("The token sent with the call (Example)", ["aud", "scope"]),
    notice: "This is the only message that runs something. The confirm dialog shows these exact arguments first, and the server refuses a call whose arguments differ from what you approved.",
  },
  agent: {
    title: "Agent with no scan",
    traffic: false,
    none: "No new network call here: the agent takes the same tools/list reply and puts it straight into the model's context, with nothing checking it first.",
    res: { line: "HTTP/1.1 200 OK (the same tools/list reply)", headers: [], body: json({ result: { tools: [{ name: "get_time", description: "Get the current time. <instruction hidden from the user>" }] } }) },
    notice: "Nothing in MCP stops hidden text in a description from steering the model. Only a check before ingest does.",
  },
  priv: {
    title: "Privilege demo: a gateway that controls the call",
    traffic: true,
    req: { line: "POST /mcp HTTP/1.1", headers: ["Host: gateway.example.com", `Authorization: ${bearer}`, "Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_all", arguments: {} } }) },
    res: { line: "HTTP/1.1 403 Forbidden", headers: ["Content-Type: application/json"], body: json({ error: "policy denied", detail: "scope tools:call does not cover delete_all" }) },
    token: tok("The token the gateway checks against its policy (Example)", ["scope", "sub"]),
    notice: "The gateway knows who is calling and what the policy allows, so it can refuse a call even when the token is valid. Controlling calls is that separate product's job, not this tool's.",
  },
};

// The entitled-listing view (Ping release claim of 2026-11-02 (listing and cap measured on gateway v1.261106; access by caller measured per aggregate (2026-11-09), per-tool filtering per caller UNVERIFIED on our tenant)). Examples only; the Entitled
// listing page shows what the simulated engine actually returns.
const GW_HOST = "gateway.example.com";
WIRE.gcaller = {
  title: "The caller asks what it may use",
  traffic: true,
  req: { line: "POST /mcp HTTP/1.1", headers: [`Host: ${GW_HOST}`, `Authorization: ${bearer}`, "Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
  res: { line: "HTTP/1.1 200 OK", headers: ["Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "crm__find_customer" }, { name: "wiki__search_pages" }] } }) },
  token: tok("The token that tells the gateway who is asking (Example)", ["sub", "scope"]),
  notice: "The list holds only what this caller is entitled to. Nothing in the reply says what was left out. A different caller gets a different list.",
};
WIRE.ggw = {
  title: "Gateway: entitlement-aware discovery",
  traffic: false,
  none: "This happens inside the gateway. It decides per caller which tools exist for them, so a tool the caller may not use is removed from the list rather than only refused later.",
  notice: "Hiding is not enough. The same tool, called by name, is refused again; both are tested on the Entitled listing page.",
};
WIRE.gagg = {
  title: "Aggregate: namespaced tools and a policy cap",
  traffic: true,
  req: { line: "POST /mcp HTTP/1.1", headers: [`Host: ${GW_HOST}`, `Authorization: ${bearer}`, "Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crm__export_all", arguments: {} } }) },
  res: { line: "HTTP/1.1 403 Forbidden", headers: ["Content-Type: application/json"], body: json({ error: "tool_not_available", message: "That tool is not available to this caller." }) },
  token: tok("The same caller token (Example)", ["sub", "scope"]),
  notice: "Member tools carry the member alias, alias__tool. The aggregate's policy is a cap: a tool the member would allow is still refused when the cap does not. The refusal words are the same for a hidden tool and for one that does not exist.",
};
WIRE.ghop = {
  title: "Member hop: the cap is checked again",
  traffic: false,
  none: "After routing, before the call is forwarded to the member, the cap and the member's own policy are checked a second time with the member's own tool name. A stale list or a routing slip cannot get past it.",
  notice: "One policy, enforced twice: on the listing and at the hop. The tests drive the hop on its own to prove it.",
};
WIRE.gmember = {
  title: "Member MCP server",
  traffic: true,
  req: { line: "POST /mcp HTTP/1.1", headers: ["Host: crm.example.com", "Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_customer", arguments: { id: "c-1" } } }) },
  res: { line: "HTTP/1.1 200 OK", headers: ["Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "done" }] } }) },
  notice: "The member sees its own tool name, without the alias. Used directly, the same member follows only its own policy: no cap and no ToolFilter. That is the negative control in the tests.",
};
WIRE.gdown = {
  title: "A member that cannot be reached",
  traffic: false,
  none: "The member did not answer. The aggregate does not quietly list fewer tools: it reports that member as unreachable, or as needing the caller's own sign-in.",
  notice: "A silent gap would look like 'no tools here'. A reported gap tells the operator something is down.",
};

// The Server page: the call flow's two messages, built from the arguments the person previewed.
export function callWire(name, canonical, result) {
  let body = canonical;
  try { body = json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: JSON.parse(canonical) }); } catch { /* show the text as is */ }
  return {
    traffic: true,
    req: { line: "POST /mcp HTTP/1.1", headers: [`Host: ${HOST}`, `Authorization: ${bearer}`, "Content-Type: application/json"], body },
    res: result ? { line: "HTTP/1.1 200 OK", headers: ["Content-Type: application/json"], body: json({ jsonrpc: "2.0", id: 1, result }) } : null,
    token: tok("Example token (the host and headers are examples; the body is what you previewed)", ["aud", "scope"]),
    notice: `The body is exactly the arguments you approved for ${name}. The server compares their hash with the preview and refuses a different call.`,
  };
}
