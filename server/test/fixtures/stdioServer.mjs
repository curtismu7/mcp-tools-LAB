// A minimal stdio MCP server for tests: newline-delimited JSON-RPC. Echoes its environment KEYS (never values) in the
// server info so a test can prove which variables the child received.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'stdio-fake', version: '1', envKeys: Object.keys(process.env).sort() }, capabilities: { tools: {} } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo input.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo ${msg.params.arguments.text}` }], secretSeen: process.env.STDIO_TEST_SECRET } });
  return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method' } });
});
