// stdio MCP client. Adapted from AI-DEMO2 standalone/mcp-inspector server/lib/transports/stdio.js (MIT).
// Changes: one process per connection, kept for the session, instead of one per call (a scan makes many requests);
// no shell (spawn with an argument array); the child gets a minimal environment plus the env the operator typed, not
// this process's whole environment; line and total sizes are capped; requests are matched by id.
import { spawn } from 'node:child_process';
import { PROTOCOL_VERSION, rpcError } from './http.js';

const MAX_LINE = 4 * 1024 * 1024;
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot'];

export function createStdioClient({ command, args = [], env = {}, timeoutMs = 30_000, clientInfo = { name: 'mcp-tools', version: '0.1.0' } }) {
  let child = null;
  let info = null;
  let ready = null;
  let nextId = 0;
  const waiting = new Map(); // id -> { resolve, reject, timer }
  let stderrTail = '';

  function fail(err) { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(err); } waiting.clear(); }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const w = msg && waiting.get(msg.id);
    if (!w || msg.method) return; // server-initiated requests (sampling, roots) are not answered
    waiting.delete(msg.id); clearTimeout(w.timer);
    if (msg.error) w.reject(rpcError(msg.error.message || 'MCP RPC error', 'mcp_rpc_error', { mcpCode: msg.error.code }));
    else w.resolve(msg.result);
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { waiting.delete(id); reject(rpcError(`MCP stdio request timed out after ${timeoutMs}ms`, 'mcp_timeout')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function spawnChild() {
    const base = Object.fromEntries(PASS_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    child = spawn(command, args, { shell: false, env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.length > MAX_LINE * 2 && !buf.includes('\n')) { fail(rpcError('stdio line larger than the cap', 'mcp_reply_too_large')); child.kill(); return; }
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-1000); });
    child.stdin.on('error', () => {});
    child.on('error', (err) => { fail(rpcError(`failed to start MCP server: ${err.code || 'spawn error'}`, 'mcp_spawn_failed')); child = null; ready = null; });
    child.on('exit', (code) => { fail(rpcError(`MCP server exited (code ${code}) before responding`, 'mcp_exited')); child = null; ready = null; });
  }

  async function handshake() {
    spawnChild();
    const result = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo });
    info = { protocolVersion: result?.protocolVersion || PROTOCOL_VERSION, serverInfo: result?.serverInfo || null, capabilities: result?.capabilities || {} };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  const ensure = () => (ready ||= handshake().catch((e) => { ready = null; child?.kill(); throw e; }));

  return {
    ensure,
    async rpc(method, params = {}) { await ensure(); return request(method, params); },
    info: () => info,
    stderrTail: () => stderrTail,
    async close() { ready = null; child?.kill(); child = null; },
  };
}
