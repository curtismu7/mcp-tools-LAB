// A minimal stdio MCP server for tests: newline-delimited JSON-RPC. Echoes its environment KEYS (never values) in the
// server info so a test can prove which variables the child received.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// Server-initiated traffic for the proxy's stdio stream: tool "ask" sends a progress notification and a roots/list
// request to the client, and finishes once the client's answer comes back; "seen" lists the client notifications.
const notes = [];
let pendingCall = null;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id === 's-1') { // the client's answer to our roots/list
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `roots: ${msg.result?.roots?.length ?? 'error'}` } });
    if (pendingCall !== null) { send({ jsonrpc: '2.0', id: pendingCall, result: { content: [{ type: 'text', text: 'asked' }] } }); pendingCall = null; }
    return;
  }
  if (msg.id === undefined) { notes.push(msg.method); return; }
  if (msg.method === 'tools/call' && msg.params?.name === 'ask') {
    pendingCall = msg.id;
    send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 1, total: 2 } });
    return send({ jsonrpc: '2.0', id: 's-1', method: 'roots/list', params: {} });
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'leak') { send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `env:${process.env.STDIO_TEST_SECRET}` } }); return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'leaked' }] } }); }
  if (msg.method === 'tools/call' && msg.params?.name === 'seen') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: notes.join(',') }] } });
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'stdio-fake', version: '1', envKeys: Object.keys(process.env).sort() }, capabilities: { tools: {} } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo input.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo ${msg.params.arguments.text}` }], secretSeen: process.env.STDIO_TEST_SECRET } });
  return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method' } });
});
