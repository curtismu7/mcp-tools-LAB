// A small in-process MCP server over Streamable HTTP, for tests. Records every request so tests can assert what was
// (and was not) sent: the auth header, tools/call arguments, and that a scan never calls a tool.
import http from 'node:http';

export const SAMPLE_TOOLS = [
  { name: 'get_time', description: 'Get the current time.', inputSchema: { type: 'object', properties: { tz: { type: 'string', description: 'Time zone' } } } },
];

export function startFakeMcp({ tools = SAMPLE_TOOLS, resources = [], prompts = [], sse = false, pageSize = 0, token } = {}) {
  const seen = { auth: [], calls: [], methods: [], hosts: [] };
  const sessions = new Set();
  const state = { tools, resources, prompts };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.hosts.push(req.headers.host);
      if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); res.writeHead(204).end(); return; }
      seen.auth.push(req.headers.authorization || null);
      if (token && req.headers.authorization !== token) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `bad token ${req.headers.authorization}` })); return; }
      const msg = JSON.parse(body || '{}');
      seen.methods.push(msg.method);
      const reply = (result, error) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) });
        if (sse) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${payload}\n\n`);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
      };
      if (msg.method === 'initialize') {
        const sid = `sess-${sessions.size + 1}`;
        sessions.add(sid);
        res.setHeader('Mcp-Session-Id', sid);
        return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1.0' }, capabilities: { tools: {}, ...(state.resources.length ? { resources: {} } : {}), ...(state.prompts.length ? { prompts: {} } : {}) } });
      }
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      if (!sessions.has(req.headers['mcp-session-id'])) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown or expired MCP-Session-Id' })); return; }
      if (msg.method === 'tools/list') {
        if (pageSize) {
          const start = Number(msg.params?.cursor || 0);
          const next = start + pageSize;
          return reply({ tools: state.tools.slice(start, next), ...(next < state.tools.length ? { nextCursor: String(next) } : {}) });
        }
        return reply({ tools: state.tools });
      }
      if (msg.method === 'tools/call') { seen.calls.push(msg.params); return reply({ content: [{ type: 'text', text: `called ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` }] }); }
      if (msg.method === 'resources/list') return reply({ resources: state.resources.map(({ contents, ...r }) => r) });
      if (msg.method === 'resources/read') return reply({ contents: state.resources.find((r) => r.uri === msg.params.uri)?.contents || [] });
      if (msg.method === 'prompts/list') return reply({ prompts: state.prompts.map(({ messages, ...p }) => p) });
      if (msg.method === 'prompts/get') return reply({ messages: state.prompts.find((p) => p.name === msg.params.name)?.messages || [] });
      if (msg.method === 'logging/setLevel') { seen.calls.push({ setLevel: msg.params }); return reply({}); }
      return reply(null, { code: -32601, message: `no method ${msg.method}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/mcp`, seen, sessions, state,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
