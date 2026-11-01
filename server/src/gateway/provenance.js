// How every name and claim in this feature is tagged. The four tags:
//   swagger  = console swagger name, 2026-10-31, schema only (the name exists in the console API schema; nothing was called)
//   deck     = deck claim (the release deck says so; UNVERIFIED on our tenant; no swagger field)
//   reading  = lab reading (our interpretation of a schema name or a deck sentence)
//   invented = lab-invented (a shape this lab made up to be able to show the claim)
export const TAG_TEXT = Object.freeze({
  swagger: 'console swagger name, 2026-10-31, schema only',
  deck: 'deck claim, UNVERIFIED on our tenant',
  reading: 'lab reading',
  invented: 'lab-invented',
});

export const BANNER = 'Ping release claim (2026-11-02), UNVERIFIED on our tenant';

export const PROVENANCE = Object.freeze([
  { name: 'mcp-aggregate', tag: 'swagger', note: 'AppType value on the console API' },
  { name: 'Members', tag: 'swagger', note: 'on modelMcpAppConfig, wrapped by modelMcpAggregateMembers; existed on 2026-10-26' },
  { name: 'AppRef', tag: 'swagger', note: 'modelMcpAggregateMember field (an object reference)' },
  { name: 'Alias', tag: 'swagger', note: 'modelMcpAggregateMember field; the schema text says tools are namespaced as Alias__tool' },
  { name: 'ToolFilter', tag: 'swagger', note: 'modelMcpAggregateMember field, a string array' },
  { name: 'ToolFilter as an allow-list', tag: 'reading', note: 'the schema gives only the name and type; allow-list meaning is our reading' },
  { name: 'alias__tool naming', tag: 'swagger', note: 'from the modelMcpAggregateMember schema description' },
  { name: 'entitlement-aware discovery', tag: 'deck', note: 'slide 36; no swagger field; the model here is lab-invented' },
  { name: 'removed from tools/list and refused by name', tag: 'deck', note: 'slides 36 and 37; behaviour not measured on our tenant' },
  { name: 'aggregate policy cap', tag: 'deck', note: 'slide 37; no swagger field, so no field name is given to it here' },
  { name: 'cap enforced twice', tag: 'deck', note: 'slide 37: on the listing and again at the member hop' },
  { name: 'unreachable member reported', tag: 'deck', note: 'slide 37; the status words are lab-invented' },
  { name: 'per-user upstream sign-in', tag: 'deck', note: 'slide 37; modelled as a yes/no per caller, no token exists' },
  { name: 'member policy', tag: 'reading', note: 'the member MCP server own policy; per-caller tool lists are lab-invented' },
  { name: 'gateway-claim/1 config, caller ids, layer names, trace', tag: 'invented', note: 'the lab own wire shape; not a Ping format' },
  { name: 'identity of a caller', tag: 'reading', note: 'API object stays NonHumanIdentity; Federated Identity is a display name only. Callers here are plain labels' },
]);
