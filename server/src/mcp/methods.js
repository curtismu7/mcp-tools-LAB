// The protocol methods besides tools/list and tools/call, with the form each one takes. Ported from the catalog in
// AI-DEMO2 standalone/mcp-inspector server/index.js (MIT). `confirm: true` = changes server state, so it is gated
// like tools/call.
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
export const PROTOCOL_METHODS = [
  { method: 'resources/list', description: 'List the resources this server exposes.', inputSchema: obj() },
  { method: 'resources/templates/list', description: 'List the parameterized resource URI templates this server exposes.', inputSchema: obj() },
  { method: 'resources/read', description: 'Read one resource by URI.', inputSchema: obj({ uri: { type: 'string', description: 'Resource URI' } }, ['uri']) },
  { method: 'prompts/list', description: 'List the prompt templates this server exposes.', inputSchema: obj() },
  { method: 'prompts/get', description: 'Fetch one prompt template, with its arguments interpolated.', inputSchema: obj({ name: { type: 'string', description: 'Prompt name' }, arguments: { type: 'object', description: 'JSON object of prompt arguments' } }, ['name']) },
  { method: 'completion/complete', description: 'Ask the server to complete a partially-typed prompt or resource argument.', inputSchema: obj({ ref: { type: 'object', description: 'What is being completed, e.g. { "type": "ref/prompt", "name": "..." }' }, argument: { type: 'object', description: 'The argument and its partial value' } }, ['ref', 'argument']) },
  { method: 'logging/setLevel', description: 'Set the minimum severity the server emits log notifications for. Changes server state, so it needs the confirm step.', confirm: true, inputSchema: obj({ level: { type: 'string', enum: ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] } }, ['level']) },
];
